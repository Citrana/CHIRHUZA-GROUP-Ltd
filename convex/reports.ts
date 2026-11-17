import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery, loadPermissions } from "./lib/rbac";
import { logAudit, diff } from "./lib/audit";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import {
  AVAILABLE_CHANNELS,
  DEFAULT_SCHEDULE,
  MAX_ATTEMPTS,
  MAX_RECIPIENTS,
  REPORT_SECTIONS,
  RETRY_DELAY_MS,
  assertSchedule,
  cleanSections,
  contentFor,
  customRange,
  nextRunAt,
  periodFor,
  reportBuilder,
  reportChannelValidator,
  reportFrequencyValidator,
  reportSectionValidator,
  usersWithPermission,
  visibleSections,
  type ReportSection,
} from "./lib/reports";
import { businessDayOf } from "./lib/time";

/**
 * Reports: scheduled (reports:runDue, every 15 minutes from crons.ts) and
 * custom (generate). Read-only on business data: building a report never
 * changes money or stock. Every run is audited; a failed scheduled run is
 * retried once, then saved as "failed". Gated by reports.view / .generate /
 * .settings (owners and admins); the cash section only for cash.view.
 */

const DUE_BATCH = 50;

function summary(report: Pick<Doc<"reports">, "kind" | "from" | "to" | "sections" | "status" | "attempts">) {
  return { kind: report.kind, from: report.from, to: report.to, sections: report.sections, status: report.status, attempts: report.attempts };
}

// ------------------------------------------------------------------ reads

/** The service's saved reports, newest first. */
export const list = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await ctx.requirePermission("reports.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const page = await ctx.db
      .query("reports")
      .withIndex("by_businessUnitId_and_generatedAt", (q) => q.eq("businessUnitId", unit._id))
      .order("desc")
      .paginate(args.paginationOpts);
    const names = new Map<Id<"users">, string>();
    const nameOf = async (id: Id<"users">) => {
      if (!names.has(id)) names.set(id, (await ctx.db.get("users", id))?.name ?? "?");
      return names.get(id)!;
    };
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (r) => ({
          _id: r._id,
          kind: r.kind,
          from: r.from,
          to: r.to,
          status: r.status,
          generatedAt: r.generatedAt,
          createdByName: await nameOf(r.createdBy),
        })),
      ),
    };
  },
});

/** One report, limited to the sections the viewer may see. */
export const get = authedQuery({
  args: { reportId: v.id("reports") },
  handler: async (ctx, { reportId }) => {
    await ctx.requirePermission("reports.view");
    const report = await ctx.db.get("reports", reportId);
    if (!report) return null;
    const unit = await ctx.db.get("businessUnits", report.businessUnitId);
    const creator = await ctx.db.get("users", report.createdBy);
    const can = (key: Parameters<typeof ctx.can>[0]) => ctx.can(key);
    return {
      _id: report._id,
      businessUnitKey: unit?.key ?? null,
      kind: report.kind,
      from: report.from,
      to: report.to,
      status: report.status,
      error: report.error ?? null,
      generatedAt: report.generatedAt,
      createdByName: creator?.name ?? "?",
      sections: visibleSections(report.sections, can),
      content: contentFor(report.content, can),
    };
  },
});

// --------------------------------------------------------------- generate

/** A report for a chosen period (at most 12 months), made now and saved. */
export const generate = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    from: v.string(),
    to: v.string(),
    sections: v.optional(v.array(reportSectionValidator)),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("reports.generate");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const now = Date.now();
    const range = customRange(args.from, args.to, now);
    const can = (key: Parameters<typeof ctx.can>[0]) => ctx.can(key);
    const sections = visibleSections(cleanSections(args.sections ?? [...REPORT_SECTIONS]), can);
    if (sections.length === 0) throw new ConvexError("Pick at least one section.");
    const content = await reportBuilder.build(ctx, unit._id, range, sections, now);
    const doc = {
      businessUnitId: unit._id,
      kind: "custom" as const,
      createdBy: ctx.user._id,
      ...range,
      sections,
      status: "ready" as const,
      attempts: 1,
      generatedAt: now,
      content,
    };
    const reportId = await ctx.db.insert("reports", doc);
    await ctx.audit({ action: "create", entityTable: "reports", entityId: reportId, businessUnitId: unit._id, after: summary(doc) });
    return reportId;
  },
});

// --------------------------------------------------------------- settings

/** People who may receive reports (they hold reports.view). */
export const recipientOptions = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("reports.settings");
    return (await usersWithPermission(ctx, "reports.view")).map((u) => ({ _id: u._id, name: u.name }));
  },
});

/** The caller's scheduled report set-up for a service (the default when none saved). */
export const getSettings = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("reports.settings");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const row = await settingsOf(ctx, unit._id, ctx.user._id);
    if (row) {
      return {
        saved: true,
        enabled: row.enabled,
        frequency: row.frequency,
        dayOfWeek: row.dayOfWeek,
        dayOfMonth: row.dayOfMonth,
        time: row.time,
        sections: row.sections,
        recipientIds: row.recipientIds,
        channels: row.channels,
        nextRunAt: row.enabled ? row.nextRunAt : null,
      };
    }
    const can = (key: Parameters<typeof ctx.can>[0]) => ctx.can(key);
    return {
      saved: false,
      enabled: false,
      ...DEFAULT_SCHEDULE,
      sections: visibleSections([...REPORT_SECTIONS], can),
      recipientIds: [ctx.user._id],
      channels: ["in_app" as const],
      nextRunAt: null,
    };
  },
});

async function settingsOf(ctx: QueryCtx, unitId: Id<"businessUnits">, ownerId: Id<"users">) {
  return await ctx.db
    .query("reportSettings")
    .withIndex("by_businessUnitId_and_ownerId", (q) => q.eq("businessUnitId", unitId).eq("ownerId", ownerId))
    .unique();
}

export const saveSettings = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    enabled: v.boolean(),
    frequency: reportFrequencyValidator,
    dayOfWeek: v.number(),
    dayOfMonth: v.number(),
    time: v.string(),
    sections: v.array(reportSectionValidator),
    recipientIds: v.array(v.id("users")),
    channels: v.array(reportChannelValidator),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("reports.settings");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const schedule = { frequency: args.frequency, dayOfWeek: args.dayOfWeek, dayOfMonth: args.dayOfMonth, time: args.time };
    assertSchedule(schedule);
    const sections = cleanSections(args.sections);
    if (!ctx.can("cash.view") && sections.includes("cash")) throw new ConvexError("Only the owner can add the cash section.");

    const channels = [...new Set(args.channels)];
    if (channels.length === 0) throw new ConvexError("Pick at least one way to send it.");
    if (channels.some((c) => !AVAILABLE_CHANNELS.includes(c))) throw new ConvexError("Email isn't available yet.");

    const recipientIds = [...new Set(args.recipientIds)];
    if (recipientIds.length === 0) throw new ConvexError("Pick at least one person to send it to.");
    if (recipientIds.length > MAX_RECIPIENTS) throw new ConvexError(`Pick at most ${MAX_RECIPIENTS} people.`);
    const allowed = new Set((await usersWithPermission(ctx, "reports.view")).map((u) => u._id));
    if (recipientIds.some((id) => !allowed.has(id))) throw new ConvexError("Reports can only go to people who can see reports.");

    const now = Date.now();
    const fields = {
      enabled: args.enabled,
      ...schedule,
      sections,
      recipientIds,
      channels,
      nextRunAt: nextRunAt(schedule, now),
      updatedBy: ctx.user._id,
      updatedAt: now,
    };
    const readable = (f: Omit<typeof fields, "nextRunAt" | "updatedBy" | "updatedAt">) => ({
      enabled: f.enabled,
      frequency: f.frequency,
      dayOfWeek: f.dayOfWeek,
      dayOfMonth: f.dayOfMonth,
      time: f.time,
      sections: f.sections,
      recipientIds: f.recipientIds,
      channels: f.channels,
    });
    const existing = await settingsOf(ctx, unit._id, ctx.user._id);
    if (!existing) {
      const id = await ctx.db.insert("reportSettings", { businessUnitId: unit._id, ownerId: ctx.user._id, ...fields });
      await ctx.audit({ action: "create", entityTable: "reportSettings", entityId: id, businessUnitId: unit._id, after: { owner: ctx.user.name, ...readable(fields) } });
      return id;
    }
    const changes = diff(readable(existing), readable(fields));
    if (!changes) return existing._id;
    await ctx.db.patch("reportSettings", existing._id, fields);
    await ctx.audit({ action: "update", entityTable: "reportSettings", entityId: existing._id, businessUnitId: unit._id, ...changes });
    return existing._id;
  },
});

// -------------------------------------------------------- scheduled runs

/** Every 15 minutes (crons.ts): starts the reports that are due. */
export const runDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("reportSettings")
      .withIndex("by_enabled_and_nextRunAt", (q) => q.eq("enabled", true).lte("nextRunAt", now))
      .take(DUE_BATCH);
    for (const row of due) {
      // Move the next run on first, in this same transaction: a report
      // never starts twice, even if the run itself fails.
      await ctx.db.patch("reportSettings", row._id, { nextRunAt: nextRunAt(row, now) });
      await ctx.scheduler.runAfter(0, internal.reports.runScheduled, { settingsId: row._id, runAt: row.nextRunAt, attempt: 1 });
    }
    return due.length;
  },
});

/** Runs one scheduled report; on failure retries once, then records the failure. */
export const runScheduled = internalAction({
  args: { settingsId: v.id("reportSettings"), runAt: v.number(), attempt: v.number() },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.reports.generateScheduled, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.attempt < MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(RETRY_DELAY_MS, internal.reports.runScheduled, { ...args, attempt: args.attempt + 1 });
      } else {
        await ctx.runMutation(internal.reports.recordFailure, { ...args, error: message.slice(0, 500) });
      }
    }
  },
});

/** The set-up's owner, if they still may see reports; else null (nothing is sent). */
async function activeOwner(ctx: MutationCtx, settings: Doc<"reportSettings">) {
  const owner = await ctx.db.get("users", settings.ownerId);
  if (!owner || owner.status !== "active") return null;
  const permissions = await loadPermissions(ctx, owner);
  return permissions.has("reports.settings") ? { owner, permissions } : null;
}

async function notify(ctx: MutationCtx, report: { _id: Id<"reports">; businessUnitId: Id<"businessUnits"> }, userIds: Id<"users">[], now: number) {
  const allowed = new Set((await usersWithPermission(ctx, "reports.view")).map((u) => u._id));
  for (const userId of new Set(userIds)) {
    if (!allowed.has(userId)) continue;
    await ctx.db.insert("notifications", { userId, businessUnitId: report.businessUnitId, reportId: report._id, createdAt: now });
  }
}

export const generateScheduled = internalMutation({
  args: { settingsId: v.id("reportSettings"), runAt: v.number(), attempt: v.number() },
  handler: async (ctx, { settingsId, runAt, attempt }) => {
    const settings = await ctx.db.get("reportSettings", settingsId);
    if (!settings || !settings.enabled) return null;
    const who = await activeOwner(ctx, settings);
    if (!who) return null;
    const now = Date.now();
    const range = periodFor(settings.frequency, businessDayOf(runAt));
    const sections: ReportSection[] = visibleSections(settings.sections, (k) => who.permissions.has(k));
    const content = await reportBuilder.build(ctx, settings.businessUnitId, range, sections, now);
    const doc = {
      businessUnitId: settings.businessUnitId,
      kind: "scheduled" as const,
      settingsId,
      createdBy: settings.ownerId,
      ...range,
      sections,
      status: "ready" as const,
      attempts: attempt,
      generatedAt: now,
      content,
    };
    const reportId = await ctx.db.insert("reports", doc);
    await notify(ctx, { _id: reportId, businessUnitId: settings.businessUnitId }, settings.recipientIds, now);
    await logAudit(ctx, {
      actorId: settings.ownerId,
      action: "create",
      entityTable: "reports",
      entityId: reportId,
      businessUnitId: settings.businessUnitId,
      after: { ...summary(doc), frequency: settings.frequency, recipients: settings.recipientIds.length },
    });
    return reportId;
  },
});

/** After the retry also failed: a "failed" report in the history, the owner told. */
export const recordFailure = internalMutation({
  args: { settingsId: v.id("reportSettings"), runAt: v.number(), attempt: v.number(), error: v.string() },
  handler: async (ctx, { settingsId, runAt, attempt, error }) => {
    const settings = await ctx.db.get("reportSettings", settingsId);
    if (!settings) return null;
    const now = Date.now();
    const range = periodFor(settings.frequency, businessDayOf(runAt));
    const doc = {
      businessUnitId: settings.businessUnitId,
      kind: "scheduled" as const,
      settingsId,
      createdBy: settings.ownerId,
      ...range,
      sections: settings.sections,
      status: "failed" as const,
      attempts: attempt,
      generatedAt: now,
      content: {},
      error,
    };
    const reportId = await ctx.db.insert("reports", doc);
    await notify(ctx, { _id: reportId, businessUnitId: settings.businessUnitId }, [settings.ownerId], now);
    await logAudit(ctx, {
      actorId: settings.ownerId,
      action: "create",
      entityTable: "reports",
      entityId: reportId,
      businessUnitId: settings.businessUnitId,
      after: { ...summary(doc), error },
    });
    return reportId;
  },
});

// ---------------------------------------------------------- notifications

/** The caller's latest notifications (their own only) and the unread count. */
export const myNotifications = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", ctx.user._id))
      .order("desc")
      .take(20);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_readAt", (q) => q.eq("userId", ctx.user._id).eq("readAt", undefined))
      .take(100);
    const items = [];
    for (const n of rows) {
      const report = await ctx.db.get("reports", n.reportId);
      const unit = await ctx.db.get("businessUnits", n.businessUnitId);
      if (!report || !unit) continue;
      items.push({
        _id: n._id,
        reportId: n.reportId,
        businessUnitKey: unit.key,
        kind: report.kind,
        status: report.status,
        from: report.from,
        to: report.to,
        createdAt: n.createdAt,
        read: n.readAt !== undefined,
      });
    }
    return { items, unread: unread.length };
  },
});

/** Marks the caller's own notifications read (one, or all). */
export const markRead = authedMutation({
  args: { notificationId: v.optional(v.id("notifications")) },
  handler: async (ctx, { notificationId }) => {
    const now = Date.now();
    const rows = notificationId
      ? [await ctx.db.get("notifications", notificationId)]
      : await ctx.db
          .query("notifications")
          .withIndex("by_userId_and_readAt", (q) => q.eq("userId", ctx.user._id).eq("readAt", undefined))
          .take(100);
    for (const n of rows) {
      if (!n || n.userId !== ctx.user._id || n.readAt !== undefined) continue;
      // Personal inbox state, not business data: not audited.
      await ctx.db.patch("notifications", n._id, { readAt: now });
    }
    return null;
  },
});
