import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { activePeople, locationFor, pickableLocations } from "./lib/locationScope";
import { withdrawalStatusValidator } from "./lib/withdrawals";
import { atClockTimeOn, businessDayEndUtc, businessDayOf, businessDayStartUtc, isBusinessDay } from "./lib/time";

/**
 * Withdrawals (convex/lib/withdrawals.ts): withdrawals.request asks (its
 * scope locks the location); the Chief Admin approves through the approval
 * engine; withdrawals.view lists them (own_location: that location). Never
 * part of profit.
 */

const MAX_ROWS = 2000;

const listFilters = {
  businessUnitKey: businessUnitKeyValidator,
  locationId: v.optional(v.id("locations")),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  status: v.optional(withdrawalStatusValidator),
};

type Filters = {
  businessUnitKey: Doc<"businessUnits">["key"];
  locationId?: Id<"locations">;
  from?: string;
  to?: string;
  status?: Doc<"withdrawals">["status"];
};

/** The withdrawals a caller may see under the filters (null = none). */
async function visibleWithdrawals(ctx: AuthedQueryCtx, args: Filters) {
  const { scope } = await ctx.requirePermission("withdrawals.view");
  const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
  for (const day of [args.from, args.to]) {
    if (day !== undefined && !isBusinessDay(day)) throw new ConvexError("Dates must be YYYY-MM-DD.");
  }
  const start = args.from ? businessDayStartUtc(args.from) : undefined;
  const end = args.to ? businessDayEndUtc(args.to) : undefined;
  const locationId = scope === "own_location" ? ctx.user.locationId : args.locationId;
  if (scope === "own_location" && !locationId) return null;
  const query = locationId
    ? ctx.db.query("withdrawals").withIndex("by_locationId_and_date", (q) => {
        const eq = q.eq("locationId", locationId);
        const lower = start !== undefined ? eq.gte("date", start) : eq;
        return end !== undefined ? lower.lte("date", end) : lower;
      })
    : ctx.db.query("withdrawals").withIndex("by_businessUnitId_and_date", (q) => {
        const eq = q.eq("businessUnitId", unit._id);
        const lower = start !== undefined ? eq.gte("date", start) : eq;
        return end !== undefined ? lower.lte("date", end) : lower;
      });
  return {
    query,
    keep: (w: Doc<"withdrawals">) => w.businessUnitId === unit._id && (!args.status || w.status === args.status),
  };
}

async function nameOf(ctx: AuthedQueryCtx, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  return user?.name || user?.email || null;
}

export const list = authedQuery({
  args: { ...listFilters, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...filters }) => {
    const visible = await visibleWithdrawals(ctx, filters);
    if (!visible) return { page: [], isDone: true, continueCursor: "" };
    const result = await visible.query.order("desc").paginate(paginationOpts);
    const page = await Promise.all(
      result.page.filter(visible.keep).map(async (w) => {
        const [location, approval] = await Promise.all([
          w.locationId ? ctx.db.get("locations", w.locationId) : null,
          w.approvalId ? ctx.db.get("approvals", w.approvalId) : null,
        ]);
        return {
          ...w,
          locationName: location?.name ?? null,
          takenByName: await nameOf(ctx, w.takenBy),
          requestedByName: await nameOf(ctx, w.requestedBy),
          decidedByName: await nameOf(ctx, approval?.decidedBy),
          decisionNote: approval?.decisionNote ?? null,
        };
      }),
    );
    return { ...result, page };
  },
});

/** Approved and pending totals (cents) under the same filters. */
export const totals = authedQuery({
  args: listFilters,
  handler: async (ctx, filters) => {
    const visible = await visibleWithdrawals(ctx, filters);
    const rows = visible ? (await visible.query.take(MAX_ROWS)).filter(visible.keep) : [];
    const sum = (status: string) => rows.filter((w) => w.status === status).reduce((s, w) => s + w.amount, 0);
    return { approved: sum("approved"), pending: sum("pending"), currency: "USD" as const };
  },
});

/** What the request form needs: allowed locations and people. */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("withdrawals.request");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const { locked, locations } = await pickableLocations(ctx, unit._id, scope);
    return {
      locked,
      locations: locations.map((l) => ({ _id: l._id, name: l.name })),
      people: await activePeople(ctx),
    };
  },
});

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.optional(v.id("locations")),
    // Who took the cash; missing = the requester.
    takenBy: v.optional(v.id("users")),
    reason: v.string(),
    // The business day it was taken (YYYY-MM-DD); missing = today.
    date: v.optional(v.string()),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("withdrawals.request");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const location = await locationFor(ctx, unit._id, scope, args.locationId);

    const takenById = args.takenBy ?? ctx.user._id;
    const takenBy = await ctx.db.get("users", takenById);
    if (!takenBy || takenBy.status !== "active") throw new ConvexError("Choose an active person.");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Give the reason for the withdrawal.");
    if (reason.length > 300) throw new ConvexError("The reason is too long.");
    const note = args.note?.trim() || undefined;
    if (note && note.length > 500) throw new ConvexError("The note is too long.");
    if (!Number.isSafeInteger(args.amount) || args.amount < 1) {
      throw new ConvexError("The amount must be a whole number of cents above 0.");
    }
    const now = Date.now();
    const today = businessDayOf(now);
    const day = args.date ?? today;
    if (!isBusinessDay(day)) throw new ConvexError("The date must be YYYY-MM-DD.");
    if (day > today) throw new ConvexError("A withdrawal can't be dated in the future.");

    const withdrawalId = await ctx.db.insert("withdrawals", {
      businessUnitId: unit._id,
      ...(location ? { locationId: location._id } : {}),
      amount: args.amount,
      currency: "USD",
      takenBy: takenById,
      reason,
      date: atClockTimeOn(day, now),
      ...(note ? { note } : {}),
      status: "pending",
      requestedBy: ctx.user._id,
      createdAt: now,
    });
    const summary = {
      amount: args.amount,
      currency: "USD",
      takenBy: takenBy.name || takenBy.email,
      date: day,
      reason,
      location: location?.name ?? null,
      note: note ?? null,
    };
    const approvalId = await requestApproval(ctx, {
      type: "withdrawal",
      businessUnitId: unit._id,
      ...(location ? { locationId: location._id } : {}),
      entityTable: "withdrawals",
      entityId: withdrawalId,
      payload: { after: summary },
      reason,
    });
    await ctx.db.patch("withdrawals", withdrawalId, { approvalId });
    await ctx.audit({
      action: "create",
      entityTable: "withdrawals",
      entityId: withdrawalId,
      businessUnitId: unit._id,
      after: { ...summary, status: "pending" },
    });
    return withdrawalId;
  },
});
