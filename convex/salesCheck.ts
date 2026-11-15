import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { daysBetween, resolveRange } from "./lib/analytics";
import { describeProduct } from "./lib/products";
import { closedMarks, openDaysOf, weekdayOf } from "./lib/salesDays";
import {
  MAX_CHECK_PRODUCTS,
  MAX_CHECK_RANGE_DAYS,
  cleanCheckItems,
  rankDays,
  soldOnDay,
  type ShopDay,
} from "./lib/salesCheck";

/**
 * Check sales (convex/lib/salesCheck.ts): which days, at which shop, sold
 * a list of products. Read-only, from the dailyStats rollups. Scoped like
 * the sales list (sales.view): own_location viewers only ever see their own
 * shop. Fixing a day's sale goes through the existing sale correction.
 */

/** Rollup rows read per check (all shops together). */
const MAX_ROWS = 20_000;

export const find = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    from: v.string(),
    to: v.string(),
    locationId: v.optional(v.id("locations")),
    items: v.array(v.object({ productId: v.id("products"), qty: v.optional(v.number()) })),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("sales.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const { from, to } = resolveRange({ from: args.from, to: args.to }, Date.now());
    if (daysBetween(from, to) > MAX_CHECK_RANGE_DAYS) throw new ConvexError(`Pick at most ${MAX_CHECK_RANGE_DAYS} days.`);

    const items = cleanCheckItems(args.items);
    if (!items) throw new ConvexError("Quantities must be whole numbers from 1.");
    if (items.length === 0) throw new ConvexError("Add at least one product.");
    if (items.length > MAX_CHECK_PRODUCTS) throw new ConvexError(`Check at most ${MAX_CHECK_PRODUCTS} products.`);
    for (const item of items) {
      const product = await ctx.db.get("products", item.productId);
      if (!product || product.businessUnitId !== unit._id) throw new ConvexError("Product not found.");
    }

    // Where: own_location viewers only their own shop, like the sales list.
    let locations: Doc<"locations">[];
    if (scope === "own_location") {
      const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
      locations = own ? [own] : [];
    } else if (args.locationId) {
      const chosen = await ctx.db.get("locations", args.locationId);
      if (!chosen) throw new ConvexError("Location not found.");
      locations = [chosen];
    } else {
      locations = await ctx.db.query("locations").take(500);
    }

    const shopDays: ShopDay[] = [];
    const closed = new Map<string, "marked" | "weekday">();
    let markedClosedDays = 0;
    let read = 0;
    let truncated = false;
    for (const location of locations) {
      if (read >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const rows = await ctx.db
        .query("dailyStats")
        .withIndex("by_unit_location_day", (q) =>
          q.eq("businessUnitId", unit._id).eq("locationKey", location._id).gte("day", from).lte("day", to),
        )
        .take(MAX_ROWS - read + 1);
      if (read + rows.length > MAX_ROWS) truncated = true;
      const kept = rows.slice(0, MAX_ROWS - read);
      read += kept.length;
      const byDay = new Map<string, Doc<"dailyStats">[]>();
      for (const row of kept) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
      const marks = new Set((await closedMarks(ctx, unit._id, location._id, from, to)).map((m) => m.day));
      markedClosedDays += marks.size;
      const openDays = openDaysOf(location);
      for (const [day, dayRows] of byDay) {
        const sold = soldOnDay(dayRows);
        if (sold.size === 0) continue;
        shopDays.push({ locationId: location._id, day, sold });
        if (marks.has(day)) closed.set(`${location._id}:${day}`, "marked");
        else if (!openDays.includes(weekdayOf(day))) closed.set(`${location._id}:${day}`, "weekday");
      }
    }

    const ranked = rankDays(items, shopDays);
    const names = new Map(locations.map((l) => [l._id, l.name]));
    const productIds = new Set<Id<"products">>(items.map((i) => i.productId));
    for (const r of ranked.results) for (const e of r.extras) productIds.add(e.productId);
    const products = await Promise.all(
      [...productIds].map(async (productId) => ({ productId, ...(await describeProduct(ctx, productId)) })),
    );
    return {
      from,
      to,
      kind: ranked.kind,
      total: ranked.total,
      listed: items.length,
      results: ranked.results.map((r) => ({
        ...r,
        locationName: names.get(r.locationId) ?? null,
        closed: closed.get(`${r.locationId}:${r.day}`) ?? null,
      })),
      products,
      markedClosedDays,
      truncated,
    };
  },
});
