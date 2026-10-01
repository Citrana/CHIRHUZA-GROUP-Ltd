import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { activePeople, locationFor, pickableLocations } from "./lib/locationScope";
import { addMonths, isPeriod, payrollStatusValidator } from "./lib/payroll";
import { businessDayOf } from "./lib/time";

/**
 * Payroll (convex/lib/payroll.ts). payroll.create submits an entry (its
 * scope locks the location); the Chief Admin approves through the approval
 * engine. payroll.view lists everything (own_location: that location);
 * someone with only payroll.create sees just what they submitted - salaries
 * aren't everyone's business.
 */

const MAX_ROWS = 2000;

const listFilters = {
  businessUnitKey: businessUnitKeyValidator,
  locationId: v.optional(v.id("locations")),
  fromPeriod: v.optional(v.string()),
  toPeriod: v.optional(v.string()),
  status: v.optional(payrollStatusValidator),
};

type Filters = {
  businessUnitKey: Doc<"businessUnits">["key"];
  locationId?: Id<"locations">;
  fromPeriod?: string;
  toPeriod?: string;
  status?: Doc<"payrollEntries">["status"];
};

/**
 * The entries a caller may see under the filters, as an index query ready
 * to order/paginate, plus a post-filter for what the index can't express.
 * null = nothing to show.
 */
async function visibleEntries(ctx: AuthedQueryCtx, args: Filters) {
  const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
  for (const p of [args.fromPeriod, args.toPeriod]) {
    if (p !== undefined && !isPeriod(p)) throw new ConvexError("Periods must be YYYY-MM.");
  }
  const inRange = (e: Doc<"payrollEntries">) =>
    (!args.fromPeriod || e.period >= args.fromPeriod) &&
    (!args.toPeriod || e.period <= args.toPeriod) &&
    (!args.status || e.status === args.status);

  if (!ctx.can("payroll.view")) {
    // Submitters without payroll.view: only their own entries.
    await ctx.requirePermission("payroll.create");
    const query = ctx.db.query("payrollEntries").withIndex("by_createdBy", (q) => q.eq("createdBy", ctx.user._id));
    return {
      query,
      keep: (e: Doc<"payrollEntries">) =>
        e.businessUnitId === unit._id && inRange(e) && (!args.locationId || e.locationId === args.locationId),
    };
  }
  const { scope } = await ctx.requirePermission("payroll.view");
  const locationId = scope === "own_location" ? ctx.user.locationId : args.locationId;
  if (scope === "own_location" && !locationId) return null;
  const query = locationId
    ? ctx.db.query("payrollEntries").withIndex("by_locationId_and_period", (q) => {
        const eq = q.eq("locationId", locationId);
        const lower = args.fromPeriod ? eq.gte("period", args.fromPeriod) : eq;
        return args.toPeriod ? lower.lte("period", args.toPeriod) : lower;
      })
    : ctx.db.query("payrollEntries").withIndex("by_businessUnitId_and_period", (q) => {
        const eq = q.eq("businessUnitId", unit._id);
        const lower = args.fromPeriod ? eq.gte("period", args.fromPeriod) : eq;
        return args.toPeriod ? lower.lte("period", args.toPeriod) : lower;
      });
  return { query, keep: (e: Doc<"payrollEntries">) => e.businessUnitId === unit._id && inRange(e) };
}

async function nameOf(ctx: AuthedQueryCtx, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  return user?.name || user?.email || null;
}

export const list = authedQuery({
  args: { ...listFilters, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts, ...filters }) => {
    const visible = await visibleEntries(ctx, filters);
    if (!visible) return { page: [], isDone: true, continueCursor: "" };
    const result = await visible.query.order("desc").paginate(paginationOpts);
    const page = await Promise.all(
      result.page.filter(visible.keep).map(async (entry) => {
        const [location, approval] = await Promise.all([
          entry.locationId ? ctx.db.get("locations", entry.locationId) : null,
          entry.approvalId ? ctx.db.get("approvals", entry.approvalId) : null,
        ]);
        return {
          ...entry,
          locationName: location?.name ?? null,
          createdByName: await nameOf(ctx, entry.createdBy),
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
    const visible = await visibleEntries(ctx, filters);
    const rows = visible ? (await visible.query.take(MAX_ROWS)).filter(visible.keep) : [];
    const sum = (status: string) => rows.filter((e) => e.status === status).reduce((s, e) => s + e.amount, 0);
    return { approved: sum("approved"), pending: sum("pending"), currency: "USD" as const, ownOnly: !ctx.can("payroll.view") };
  },
});

/** What the new-entry form needs: allowed locations and people. */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("payroll.create");
    await requireBusinessUnit(ctx, businessUnitKey);
    const { locked, locations } = await pickableLocations(ctx, scope);
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
    userId: v.optional(v.id("users")),
    workerName: v.optional(v.string()),
    period: v.string(),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("payroll.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const location = await locationFor(ctx, scope, args.locationId);

    let workerName = args.workerName?.trim();
    if (args.userId) {
      const worker = await ctx.db.get("users", args.userId);
      if (!worker || worker.status !== "active") throw new ConvexError("Choose an active person.");
      workerName = worker.name || worker.email;
    }
    if (!workerName) throw new ConvexError("Say who is paid.");
    if (workerName.length > 120) throw new ConvexError("The worker's name is too long.");
    if (!isPeriod(args.period)) throw new ConvexError("The period must be a month (YYYY-MM).");
    const thisMonth = businessDayOf(Date.now()).slice(0, 7);
    if (args.period > addMonths(thisMonth, 1)) {
      throw new ConvexError("The period can't be more than a month ahead.");
    }
    if (!Number.isSafeInteger(args.amount) || args.amount < 1) {
      throw new ConvexError("The amount must be a whole number of cents above 0.");
    }
    const note = args.note?.trim() || undefined;
    if (note && note.length > 500) throw new ConvexError("The note is too long.");

    const entryId = await ctx.db.insert("payrollEntries", {
      businessUnitId: unit._id,
      ...(location ? { locationId: location._id } : {}),
      ...(args.userId ? { userId: args.userId } : {}),
      workerName,
      period: args.period,
      amount: args.amount,
      currency: "USD",
      ...(note ? { note } : {}),
      status: "pending",
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });
    const summary = {
      worker: workerName,
      period: args.period,
      amount: args.amount,
      currency: "USD",
      location: location?.name ?? null,
      note: note ?? null,
    };
    const approvalId = await requestApproval(ctx, {
      type: "payroll",
      businessUnitId: unit._id,
      ...(location ? { locationId: location._id } : {}),
      entityTable: "payrollEntries",
      entityId: entryId,
      payload: { after: summary },
      ...(note ? { reason: note } : {}),
    });
    await ctx.db.patch("payrollEntries", entryId, { approvalId });
    await ctx.audit({
      action: "create",
      entityTable: "payrollEntries",
      entityId: entryId,
      businessUnitId: unit._id,
      after: { ...summary, status: "pending" },
    });
    return entryId;
  },
});
