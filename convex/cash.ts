import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type AuthedMutationCtx, type AuthedQueryCtx } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { activePeople, locationFor, pickableLocations } from "./lib/locationScope";
import { ALL } from "./lib/analytics";
import {
  activeReversalOf,
  applyApprovedOpeningCash,
  needsApproval,
  openingCashStatusValidator,
  openingCashThreshold,
} from "./lib/openingCash";
import { atClockTimeOn, businessDayEndUtc, businessDayOf, businessDayStartUtc, isBusinessDay } from "./lib/time";

/**
 * Cash on hand and opening cash (CLAUDE.md "Cash"; convex/lib/openingCash.ts).
 * Owner-only by default: cash.view reads, cash.opening.record records and
 * reverses (its scope locks the location), cash.opening.approve decides
 * amounts above the unit's threshold, cash.settings sets that threshold.
 * Cash on hand reads the dailyFinance rollups - never raw sales.
 */

const MAX_ROWS = 2000;
const MAX_ROLLUP_DAYS = 20_000;

const listFilters = {
  businessUnitKey: businessUnitKeyValidator,
  locationId: v.optional(v.id("locations")),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  status: v.optional(openingCashStatusValidator),
};

type Filters = {
  businessUnitKey: Doc<"businessUnits">["key"];
  locationId?: Id<"locations">;
  from?: string;
  to?: string;
  status?: Doc<"openingCash">["status"];
};

/** The opening cash rows a caller may see under the filters (null = none). */
async function visibleRows(ctx: AuthedQueryCtx, args: Filters) {
  const { scope } = await ctx.requirePermission("cash.view");
  const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
  for (const day of [args.from, args.to]) {
    if (day !== undefined && !isBusinessDay(day)) throw new ConvexError("Dates must be YYYY-MM-DD.");
  }
  const start = args.from ? businessDayStartUtc(args.from) : undefined;
  const end = args.to ? businessDayEndUtc(args.to) : undefined;
  const locationId = scope === "own_location" ? ctx.user.locationId : args.locationId;
  if (scope === "own_location" && !locationId) return null;
  const query = locationId
    ? ctx.db.query("openingCash").withIndex("by_locationId_and_date", (q) => {
        const eq = q.eq("locationId", locationId);
        const lower = start !== undefined ? eq.gte("date", start) : eq;
        return end !== undefined ? lower.lte("date", end) : lower;
      })
    : ctx.db.query("openingCash").withIndex("by_businessUnitId_and_date", (q) => {
        const eq = q.eq("businessUnitId", unit._id);
        const lower = start !== undefined ? eq.gte("date", start) : eq;
        return end !== undefined ? lower.lte("date", end) : lower;
      });
  return {
    query,
    keep: (row: Doc<"openingCash">) => row.businessUnitId === unit._id && (!args.status || row.status === args.status),
  };
}

async function nameOf(ctx: AuthedQueryCtx, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  return user?.name || user?.email || null;
}

/** A row with the names and reversal state the page shows. */
async function describe(ctx: AuthedQueryCtx, row: Doc<"openingCash">) {
  const [location, approval, reversal, reverses] = await Promise.all([
    row.locationId ? ctx.db.get("locations", row.locationId) : null,
    row.approvalId ? ctx.db.get("approvals", row.approvalId) : null,
    row.kind === "record" ? activeReversalOf(ctx, row._id) : null,
    row.reversesId ? ctx.db.get("openingCash", row.reversesId) : null,
  ]);
  return {
    ...row,
    locationName: location?.name ?? null,
    requestedByName: await nameOf(ctx, row.requestedBy),
    decidedByName: await nameOf(ctx, approval?.decidedBy),
    decisionNote: approval?.decisionNote ?? null,
    reversal: reversal ? { _id: reversal._id, status: reversal.status, reason: reversal.reason ?? null } : null,
    reverses: reverses ? { _id: reverses._id, date: reverses.date, note: reverses.note ?? null } : null,
  };
}

export const listOpeningCash = authedQuery({
  args: { ...listFilters, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...filters }) => {
    const visible = await visibleRows(ctx, filters);
    if (!visible) return { page: [], isDone: true, continueCursor: "" };
    const result = await visible.query.order("desc").paginate(paginationOpts);
    const page = await Promise.all(result.page.filter(visible.keep).map((row) => describe(ctx, row)));
    return { ...result, page };
  },
});

/**
 * Totals (cents) under the same filters: approved = what counts in Cash on
 * hand (records less reversals), pending = waiting for an approval.
 */
export const openingCashTotals = authedQuery({
  args: listFilters,
  handler: async (ctx, filters) => {
    const visible = await visibleRows(ctx, filters);
    const rows = visible ? (await visible.query.take(MAX_ROWS)).filter(visible.keep) : [];
    const signed = (row: Doc<"openingCash">) => (row.kind === "reversal" ? -row.amount : row.amount);
    const sum = (status: string) => rows.filter((r) => r.status === status).reduce((s, r) => s + signed(r), 0);
    return { approved: sum("approved"), pending: sum("pending"), count: rows.length, currency: "USD" as const };
  },
});

/** Every row under the filters (bounded), oldest first, for the CSV export. */
export const exportOpeningCash = authedQuery({
  args: listFilters,
  handler: async (ctx, filters) => {
    const visible = await visibleRows(ctx, filters);
    if (!visible) return [];
    const rows = (await visible.query.take(MAX_ROWS)).filter(visible.keep);
    return await Promise.all(rows.map((row) => describe(ctx, row)));
  },
});

/**
 * Cash on hand today, from the dailyFinance rollups (all days up to today):
 * opening cash + cash sales + cash credit payments - cash refunds -
 * withdrawals. Never mixed into sales or profit.
 */
export const onHand = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, locationId: v.optional(v.id("locations")) },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("cash.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const empty = { openingCash: 0, cashSales: 0, cashCreditPayments: 0, cashRefunds: 0, withdrawals: 0 };
    const locationKey = scope === "own_location" ? ctx.user.locationId : (args.locationId ?? ALL);
    if (!locationKey) return { ...empty, total: 0, currency: "USD" as const };
    const today = businessDayOf(Date.now());
    const rows = await ctx.db
      .query("dailyFinance")
      .withIndex("by_key", (q) => q.eq("businessUnitId", unit._id).eq("locationKey", locationKey).lte("day", today))
      .take(MAX_ROLLUP_DAYS);
    const lines = rows.reduce(
      (s, r) => ({
        openingCash: s.openingCash + (r.openingCash ?? 0),
        cashSales: s.cashSales + (r.cashSales ?? 0),
        cashCreditPayments: s.cashCreditPayments + (r.cashCreditPayments ?? 0),
        cashRefunds: s.cashRefunds + (r.cashRefunds ?? 0),
        withdrawals: s.withdrawals + r.withdrawals,
      }),
      empty,
    );
    const total = lines.openingCash + lines.cashSales + lines.cashCreditPayments - lines.cashRefunds - lines.withdrawals;
    return { ...lines, total, currency: "USD" as const };
  },
});

/** What the record form needs: allowed locations, people and the threshold. */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("cash.opening.record");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const { locked, locations } = await pickableLocations(ctx, scope);
    return {
      locked,
      locations: locations.map((l) => ({ _id: l._id, name: l.name })),
      people: await activePeople(ctx),
      threshold: await openingCashThreshold(ctx, unit._id),
    };
  },
});

/**
 * Inserts an opening cash row: approved at once at or below the threshold,
 * otherwise pending with an approval request. Audited either way.
 */
async function insertRow(
  ctx: AuthedMutationCtx,
  row: Omit<Doc<"openingCash">, "_id" | "_creationTime" | "status" | "approvalId" | "decidedAt" | "requestedBy" | "createdAt">,
  summary: Record<string, unknown>,
  payload: Record<string, unknown>,
  reason: string,
) {
  const now = Date.now();
  const threshold = await openingCashThreshold(ctx, row.businessUnitId);
  const pending = needsApproval(row.amount, threshold);
  const base = { ...row, requestedBy: ctx.user._id, createdAt: now };
  if (!pending) {
    const doc = { ...base, status: "approved" as const, decidedAt: now };
    const id = await ctx.db.insert("openingCash", doc);
    await applyApprovedOpeningCash(ctx, { ...doc, _id: id, _creationTime: now });
    await ctx.audit({
      action: "create",
      entityTable: "openingCash",
      entityId: id,
      businessUnitId: row.businessUnitId,
      after: { ...summary, status: "approved" },
      reason,
    });
    return { id, status: "approved" as const };
  }
  const id = await ctx.db.insert("openingCash", { ...base, status: "pending" });
  const approvalId = await requestApproval(ctx, {
    type: "opening_cash",
    businessUnitId: row.businessUnitId,
    ...(row.locationId ? { locationId: row.locationId } : {}),
    entityTable: "openingCash",
    entityId: id,
    payload,
    reason,
  });
  await ctx.db.patch("openingCash", id, { approvalId });
  await ctx.audit({
    action: "create",
    entityTable: "openingCash",
    entityId: id,
    businessUnitId: row.businessUnitId,
    after: { ...summary, status: "pending" },
    reason,
  });
  return { id, status: "pending" as const };
}

export const createOpeningCash = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.optional(v.id("locations")),
    amount: v.number(),
    // The business day it was received (YYYY-MM-DD); missing = today.
    date: v.optional(v.string()),
    // Who received it: a user, or a name typed in.
    receivedByUserId: v.optional(v.id("users")),
    receivedByName: v.optional(v.string()),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("cash.opening.record");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const location = await locationFor(ctx, scope, args.locationId);

    if (!Number.isSafeInteger(args.amount) || args.amount < 1) {
      throw new ConvexError("The amount must be a whole number of cents above 0.");
    }
    let receivedByName = args.receivedByName?.trim() ?? "";
    if (args.receivedByUserId) {
      const person = await ctx.db.get("users", args.receivedByUserId);
      if (!person || person.status !== "active") throw new ConvexError("Choose an active person.");
      receivedByName = person.name || person.email || "";
    }
    if (!receivedByName) throw new ConvexError("Say who received the money.");
    if (receivedByName.length > 100) throw new ConvexError("The name is too long.");
    const note = args.note.trim();
    if (!note) throw new ConvexError("Write a note: where does this money come from?");
    if (note.length > 500) throw new ConvexError("The note is too long.");
    const now = Date.now();
    const today = businessDayOf(now);
    const day = args.date ?? today;
    if (!isBusinessDay(day)) throw new ConvexError("The date must be YYYY-MM-DD.");
    if (day > today) throw new ConvexError("Opening cash can't be dated in the future.");

    const summary = {
      kind: "record",
      amount: args.amount,
      currency: "USD",
      date: day,
      receivedBy: receivedByName,
      location: location?.name ?? null,
      note,
    };
    return await insertRow(
      ctx,
      {
        businessUnitId: unit._id,
        kind: "record",
        ...(location ? { locationId: location._id } : {}),
        amount: args.amount,
        currency: "USD",
        date: atClockTimeOn(day, now),
        ...(args.receivedByUserId ? { receivedByUserId: args.receivedByUserId } : {}),
        receivedByName,
        note,
      },
      summary,
      { after: summary },
      note,
    );
  },
});

/**
 * Reverses an approved opening cash record (the only way to undo one):
 * adds a "reversal" row for its full amount, with a reason. Same threshold
 * rule as a record.
 */
export const reverseOpeningCash = authedMutation({
  args: { openingCashId: v.id("openingCash"), reason: v.string() },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("cash.opening.record");
    const record = await ctx.db.get("openingCash", args.openingCashId);
    if (!record) throw new ConvexError("Opening cash not found.");
    if (scope === "own_location" && record.locationId !== ctx.user.locationId) {
      throw new ConvexError("You can only reverse opening cash at your own location.");
    }
    if (record.kind !== "record") throw new ConvexError("A reversal can't be reversed.");
    if (record.status !== "approved") throw new ConvexError("Only approved opening cash can be reversed.");
    if (await activeReversalOf(ctx, record._id)) throw new ConvexError("This opening cash is already reversed.");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Give the reason for the reversal.");
    if (reason.length > 300) throw new ConvexError("The reason is too long.");

    const now = Date.now();
    const location = record.locationId ? await ctx.db.get("locations", record.locationId) : null;
    const summary = {
      kind: "reversal",
      amount: record.amount,
      currency: record.currency,
      reversedOn: businessDayOf(now),
      receivedOn: businessDayOf(record.date),
      receivedBy: record.receivedByName,
      location: location?.name ?? null,
      reason,
    };
    return await insertRow(
      ctx,
      {
        businessUnitId: record.businessUnitId,
        kind: "reversal",
        ...(record.locationId ? { locationId: record.locationId } : {}),
        amount: record.amount,
        currency: record.currency,
        date: now,
        ...(record.receivedByUserId ? { receivedByUserId: record.receivedByUserId } : {}),
        receivedByName: record.receivedByName,
        reason,
        reversesId: record._id,
      },
      summary,
      {
        before: { amount: record.amount, currency: record.currency, note: record.note ?? null },
        after: { amount: 0, currency: record.currency, reversed: true },
      },
      reason,
    );
  },
});

export const getSettings = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("cash.settings");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    return { openingCashApprovalThreshold: await openingCashThreshold(ctx, unit._id), currency: "USD" as const };
  },
});

/** Sets the unit's approval threshold (cents; amounts above it need an approval). */
export const setOpeningCashThreshold = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, threshold: v.number() },
  handler: async (ctx, { businessUnitKey, threshold }) => {
    await ctx.requirePermission("cash.settings");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new ConvexError("The threshold must be a whole number of cents from 0.");
    }
    const settings = await ctx.db
      .query("cashSettings")
      .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
      .unique();
    const before = settings?.openingCashApprovalThreshold ?? 0;
    if (settings && before === threshold) return;
    const values = { openingCashApprovalThreshold: threshold, currency: "USD" as const, updatedBy: ctx.user._id, updatedAt: Date.now() };
    const id = settings
      ? (await ctx.db.patch("cashSettings", settings._id, values), settings._id)
      : await ctx.db.insert("cashSettings", { businessUnitId: unit._id, ...values });
    await ctx.audit({
      action: settings ? "update" : "create",
      entityTable: "cashSettings",
      entityId: id,
      businessUnitId: unit._id,
      ...(settings ? { before: { approvalThresholdAmount: before, currency: "USD" } } : {}),
      after: { approvalThresholdAmount: threshold, currency: "USD" },
    });
  },
});
