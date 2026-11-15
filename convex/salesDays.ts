import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { authedMutation, type AuthedMutationCtx } from "./lib/rbac";
import { snapshot } from "./lib/audit";
import { businessUnitKeyValidator, requireBusinessUnit, type BusinessUnitKey } from "./lib/businessUnits";
import { inScope } from "./lib/locationScope";
import { MAX_CLOSED_NOTE_LENGTH, openDaysOf, rowHasSale, weekdayOf } from "./lib/salesDays";
import { businessDayOf, isBusinessDay } from "./lib/time";

/**
 * "Closed / no sales" marks (convex/lib/salesDays.ts): a shop says a past
 * open day had no sales for a service, so it stops being flagged as a
 * missing sales day. Who may record sales at the shop may mark it
 * (sales.create, scoped like sales). Reversible: undoing sets active false.
 * Every change is audited.
 */

const markArgs = {
  businessUnitKey: businessUnitKeyValidator,
  locationId: v.id("locations"),
  day: v.string(),
};

/** The unit, the shop (in the caller's sales.create scope) and the existing mark, if any. */
async function target(
  ctx: AuthedMutationCtx,
  args: { businessUnitKey: BusinessUnitKey; locationId: Id<"locations">; day: string },
) {
  await ctx.requirePermission("sales.create", (scope, user) => inScope(scope, user, args.locationId));
  const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
  const location = await ctx.db.get("locations", args.locationId);
  if (!location || location.type !== "shop") throw new ConvexError("Choose a shop.");
  if (!isBusinessDay(args.day)) throw new ConvexError("Dates must be YYYY-MM-DD.");
  const existing = await ctx.db
    .query("closedSalesDays")
    .withIndex("by_unit_location_day", (q) =>
      q.eq("businessUnitId", unit._id).eq("locationId", location._id).eq("day", args.day),
    )
    .unique();
  return { unit, location, existing };
}

/** Marks a past open day with no sales as "Closed / no sales" (optional note). */
export const markClosed = authedMutation({
  args: { ...markArgs, note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { unit, location, existing } = await target(ctx, args);
    if (args.day >= businessDayOf(Date.now())) throw new ConvexError("Only past days can be marked closed.");
    if (!openDaysOf(location).includes(weekdayOf(args.day))) throw new ConvexError("The shop doesn't open on that day.");
    const [row] = await ctx.db
      .query("dailyFinance")
      .withIndex("by_key", (q) => q.eq("businessUnitId", unit._id).eq("locationKey", location._id).eq("day", args.day))
      .take(1);
    if (row && rowHasSale(row)) throw new ConvexError("This day already has sales.");
    if (existing?.active) throw new ConvexError("This day is already marked closed.");
    const note = args.note?.trim() || undefined;
    if (note && note.length > MAX_CLOSED_NOTE_LENGTH) throw new ConvexError("The note is too long.");

    const now = Date.now();
    const fields = { note, active: true, markedBy: ctx.user._id, markedAt: now };
    const readable = { locationName: location.name, day: args.day };
    if (existing) {
      await ctx.db.patch("closedSalesDays", existing._id, { ...fields, clearedBy: undefined, clearedAt: undefined });
      await ctx.audit({
        action: "update",
        entityTable: "closedSalesDays",
        entityId: existing._id,
        businessUnitId: unit._id,
        before: { ...readable, active: false, note: existing.note ?? null },
        after: { ...readable, active: true, note: note ?? null },
      });
      return existing._id;
    }
    const doc = { businessUnitId: unit._id, locationId: location._id, day: args.day, ...fields };
    const id = await ctx.db.insert("closedSalesDays", doc);
    await ctx.audit({
      action: "create",
      entityTable: "closedSalesDays",
      entityId: id,
      businessUnitId: unit._id,
      after: { ...snapshot(doc), locationName: location.name },
    });
    return id;
  },
});

/** Undoes a "Closed / no sales" mark: the day counts as missing again if nothing was sold. */
export const clearClosed = authedMutation({
  args: markArgs,
  handler: async (ctx, args) => {
    const { unit, location, existing } = await target(ctx, args);
    if (!existing?.active) throw new ConvexError("This day isn't marked closed.");
    await ctx.db.patch("closedSalesDays", existing._id, { active: false, clearedBy: ctx.user._id, clearedAt: Date.now() });
    const readable = { locationName: location.name, day: args.day };
    await ctx.audit({
      action: "update",
      entityTable: "closedSalesDays",
      entityId: existing._id,
      businessUnitId: unit._id,
      before: { ...readable, active: true },
      after: { ...readable, active: false },
    });
  },
});
