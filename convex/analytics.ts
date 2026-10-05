import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { filterableLocations } from "./lib/locationScope";
import {
  ALL,
  bucketOf,
  bucketsBetween,
  rebuildRollups as rebuild,
  resolveRange,
} from "./lib/analytics";
import { productDetails } from "./lib/products";

/**
 * Analytics queries (analytics.view). They read ONLY the rollups in
 * convex/lib/analytics.ts (dailyFinance, dailyStats) - never raw sales. An
 * own_location viewer is forced to their own location. Money: USD cents.
 */

const rangeValidator = v.union(
  v.object({ preset: v.union(v.literal("today"), v.literal("week"), v.literal("month")) }),
  v.object({ from: v.string(), to: v.string() }),
);

const MAX_STATS_ROWS = 20_000;

/** Which rollup rows to read: the unit, the location key and the day range. */
async function scopeOf(
  ctx: AuthedQueryCtx,
  args: { businessUnitKey: Doc<"businessUnits">["key"]; range: Parameters<typeof resolveRange>[0]; locationId?: Id<"locations"> },
) {
  const { scope } = await ctx.requirePermission("analytics.view");
  const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
  const { from, to } = resolveRange(args.range, Date.now());
  let locationId = args.locationId;
  if (scope === "own_location") {
    if (!ctx.user.locationId) throw new ConvexError("You have no location - ask an admin to set one.");
    locationId = ctx.user.locationId;
  }
  if (locationId) {
    const location = await ctx.db.get("locations", locationId);
    if (!location) throw new ConvexError("Location not found.");
  }
  return { unitId: unit._id, locationKey: locationId ?? ALL, from, to };
}

async function financeRows(ctx: AuthedQueryCtx, s: Awaited<ReturnType<typeof scopeOf>>) {
  return await ctx.db
    .query("dailyFinance")
    .withIndex("by_key", (q) =>
      q.eq("businessUnitId", s.unitId).eq("locationKey", s.locationKey).gte("day", s.from).lte("day", s.to),
    )
    .take(1000);
}

const commonArgs = {
  businessUnitKey: businessUnitKeyValidator,
  range: rangeValidator,
  locationId: v.optional(v.id("locations")),
};

/**
 * Totals for a range: sales, cost and margin (price - purchase cost), trip
 * expenses, payroll, net profit (margin - expenses - payroll) and - apart,
 * never subtracted - withdrawals.
 */
export const getSummary = authedQuery({
  args: commonArgs,
  handler: async (ctx, args) => {
    const s = await scopeOf(ctx, args);
    const rows = await financeRows(ctx, s);
    const sum = (f: "sales" | "saleCost" | "expenses" | "payroll" | "withdrawals") => rows.reduce((t, r) => t + r[f], 0);
    const sales = sum("sales");
    const cost = sum("saleCost");
    const margin = sales - cost;
    const expenses = sum("expenses");
    const payroll = sum("payroll");
    return {
      from: s.from,
      to: s.to,
      currency: "USD" as const,
      sales,
      cost,
      margin,
      marginPct: sales > 0 ? Math.round((margin / sales) * 1000) / 10 : null,
      expenses,
      payroll,
      withdrawals: sum("withdrawals"),
      netProfit: margin - expenses - payroll,
    };
  },
});

type ProductTotals = { unitsSold: number; revenue: number; cost: number; margin: number };

/** Per-product totals over the scope's days (products sold at least once). */
async function productTotals(ctx: AuthedQueryCtx, s: Awaited<ReturnType<typeof scopeOf>>) {
  const rows = await ctx.db
    .query("dailyStats")
    .withIndex("by_unit_location_day", (q) =>
      q.eq("businessUnitId", s.unitId).eq("locationKey", s.locationKey).gte("day", s.from).lte("day", s.to),
    )
    .take(MAX_STATS_ROWS + 1);
  const truncated = rows.length > MAX_STATS_ROWS;
  const byProduct = new Map<Id<"products">, ProductTotals>();
  for (const row of rows.slice(0, MAX_STATS_ROWS)) {
    const p = byProduct.get(row.productId) ?? { unitsSold: 0, revenue: 0, cost: 0, margin: 0 };
    p.unitsSold += row.unitsSold;
    p.revenue += row.revenue;
    p.cost += row.cost;
    p.margin += row.margin;
    byProduct.set(row.productId, p);
  }
  for (const [productId, p] of byProduct) if (p.unitsSold <= 0) byProduct.delete(productId);
  return { totals: byProduct, truncated };
}

/** Name, SKU, length, size and colour of a product, for the lists. */
async function describeProduct(ctx: AuthedQueryCtx, productId: Id<"products">) {
  const product = await ctx.db.get("products", productId);
  const details = await productDetails(ctx, product);
  return {
    productId,
    name: product?.name ?? null,
    sku: product?.sku ?? null,
    lengthInches: product?.lengthInches ?? null,
    colourName: details.colourName,
    sizeName: details.sizeName,
  };
}

/**
 * Products ranked over a range, by units sold or by margin. "asc" by units
 * = least sold among products sold at least once in the range.
 */
export const getTopProducts = authedQuery({
  args: {
    ...commonArgs,
    by: v.union(v.literal("units"), v.literal("margin")),
    order: v.union(v.literal("asc"), v.literal("desc")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const s = await scopeOf(ctx, args);
    const { totals, truncated } = await productTotals(ctx, s);
    const key = args.by === "units" ? "unitsSold" : "margin";
    const sign = args.order === "desc" ? -1 : 1;
    const ranked = [...totals.entries()]
      .sort((a, b) => sign * (a[1][key] - b[1][key]) || b[1].revenue - a[1].revenue)
      .slice(0, Math.min(Math.max(args.limit ?? 5, 1), 50));
    const products = await Promise.all(
      ranked.map(async ([productId, t]) => ({ ...(await describeProduct(ctx, productId)), ...t })),
    );
    return { products, truncated };
  },
});

/**
 * Every product sold over a range (the "Products sold" report): units,
 * revenue, cost, margin and margin %, most sold first, plus the totals.
 */
export const getProductSales = authedQuery({
  args: commonArgs,
  handler: async (ctx, args) => {
    const s = await scopeOf(ctx, args);
    const { totals, truncated } = await productTotals(ctx, s);
    const ranked = [...totals.entries()].sort(
      (a, b) => b[1].unitsSold - a[1].unitsSold || b[1].revenue - a[1].revenue,
    );
    const rows = await Promise.all(
      ranked.map(async ([productId, t]) => ({
        ...(await describeProduct(ctx, productId)),
        ...t,
        marginPct: t.revenue > 0 ? Math.round((t.margin / t.revenue) * 1000) / 10 : null,
      })),
    );
    const sum = (f: keyof ProductTotals) => rows.reduce((total, r) => total + r[f], 0);
    return {
      from: s.from,
      to: s.to,
      currency: "USD" as const,
      rows,
      totals: { unitsSold: sum("unitsSold"), revenue: sum("revenue"), cost: sum("cost"), margin: sum("margin") },
      truncated,
    };
  },
});

/** Sales, margin, expenses, payroll and withdrawals per day / week / month (empty periods as 0). */
export const getTimeSeries = authedQuery({
  args: { ...commonArgs, granularity: v.union(v.literal("day"), v.literal("week"), v.literal("month")) },
  handler: async (ctx, args) => {
    const s = await scopeOf(ctx, args);
    const rows = await financeRows(ctx, s);
    const buckets = new Map(
      bucketsBetween(s.from, s.to, args.granularity).map((start) => [
        start,
        { start, sales: 0, margin: 0, expenses: 0, payroll: 0, withdrawals: 0 },
      ]),
    );
    for (const row of rows) {
      const bucket = buckets.get(bucketOf(row.day, args.granularity));
      if (!bucket) continue;
      bucket.sales += row.sales;
      bucket.margin += row.sales - row.saleCost;
      bucket.expenses += row.expenses;
      bucket.payroll += row.payroll;
      bucket.withdrawals += row.withdrawals;
    }
    return { from: s.from, to: s.to, granularity: args.granularity, points: [...buckets.values()] };
  },
});

/** The locations the viewer may filter by (own_location: just theirs). */
export const filterLocations = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("analytics.view");
    await requireBusinessUnit(ctx, businessUnitKey);
    return await filterableLocations(ctx, scope);
  },
});

/**
 * Backfill / repair: rebuilds a unit's rollups from raw data.
 *   npx convex run analytics:rebuildRollups '{"businessUnitKey":"hair"}'
 */
export const rebuildRollups = internalMutation({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    return await rebuild(ctx, unit._id);
  },
});
