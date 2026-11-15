import type { Id } from "../_generated/dataModel";

/**
 * Check sales (convex/salesCheck.ts): which shop-days sold a list of
 * products. Read-only, from the dailyStats rollups (never raw sales). A
 * product counts as sold on a day when the shop's net units that day are
 * above 0, so voided sales, approved corrections and exchanges already
 * count where they belong. Products only match by product (the exact
 * variant); quantities never exclude a day, they're shown as differences.
 */

/** At most this many products in one check. */
export const MAX_CHECK_PRODUCTS = 20;
/** At most this many days in one check (about three months). */
export const MAX_CHECK_RANGE_DAYS = 92;
/** Default range: the last 30 days, today included. */
export const DEFAULT_CHECK_DAYS = 30;
/** At most this many results (full matches) shown. */
export const MAX_CHECK_RESULTS = 50;
/** At most this many best partial matches shown when nothing has every product. */
export const MAX_PARTIAL_RESULTS = 10;

export type CheckItem = { productId: Id<"products">; qty?: number };
export type ShopDay = { locationId: Id<"locations">; day: string; sold: ReadonlyMap<Id<"products">, number> };

export type DayMatch = {
  locationId: Id<"locations">;
  day: string;
  matched: number;
  /** Listed products the day didn't sell. */
  missing: Id<"products">[];
  /** Products sold that day that aren't on the list, most units first. */
  extras: Array<{ productId: Id<"products">; units: number }>;
  /** Listed products sold that day: units sold, and sold - entered when a quantity was entered. */
  found: Array<{ productId: Id<"products">; units: number; qtyDiff: number | null }>;
};

/** Units of each product a day sold (net units above 0 only). */
export function soldOnDay(rows: ReadonlyArray<{ productId: Id<"products">; unitsSold: number }>): Map<Id<"products">, number> {
  const sold = new Map<Id<"products">, number>();
  for (const row of rows) sold.set(row.productId, (sold.get(row.productId) ?? 0) + row.unitsSold);
  for (const [productId, units] of sold) if (units <= 0) sold.delete(productId);
  return sold;
}

/** How one shop-day compares with the list. */
export function compareDay(items: readonly CheckItem[], shopDay: ShopDay): DayMatch {
  const listed = new Set(items.map((i) => i.productId));
  const found: DayMatch["found"] = [];
  const missing: Id<"products">[] = [];
  for (const item of items) {
    const units = shopDay.sold.get(item.productId);
    if (units === undefined) missing.push(item.productId);
    else found.push({ productId: item.productId, units, qtyDiff: item.qty === undefined ? null : units - item.qty });
  }
  const extras = [...shopDay.sold.entries()]
    .filter(([productId]) => !listed.has(productId))
    .map(([productId, units]) => ({ productId, units }))
    .sort((a, b) => b.units - a.units);
  return { locationId: shopDay.locationId, day: shopDay.day, matched: found.length, missing, extras, found };
}

/**
 * The shop-days that sold every listed product, fewest extra products
 * first (then most recent). When none did: the best partial matches - most
 * listed products first, then fewest extras, then most recent.
 */
export function rankDays(
  items: readonly CheckItem[],
  shopDays: readonly ShopDay[],
): { kind: "full" | "partial" | "none"; results: DayMatch[]; total: number } {
  if (items.length === 0) return { kind: "none", results: [], total: 0 };
  const compared = shopDays.map((d) => compareDay(items, d)).filter((m) => m.matched > 0);
  const recent = (a: DayMatch, b: DayMatch) => b.day.localeCompare(a.day);
  const full = compared.filter((m) => m.missing.length === 0);
  if (full.length > 0) {
    full.sort((a, b) => a.extras.length - b.extras.length || recent(a, b));
    return { kind: "full", results: full.slice(0, MAX_CHECK_RESULTS), total: full.length };
  }
  if (compared.length === 0) return { kind: "none", results: [], total: 0 };
  compared.sort((a, b) => b.matched - a.matched || a.extras.length - b.extras.length || recent(a, b));
  return { kind: "partial", results: compared.slice(0, MAX_PARTIAL_RESULTS), total: compared.length };
}

/** The list as checked: whole quantities from 1 (or none), each product once. Null when a quantity is wrong. */
export function cleanCheckItems(items: readonly CheckItem[]): CheckItem[] | null {
  const seen = new Set<Id<"products">>();
  const out: CheckItem[] = [];
  for (const item of items) {
    if (item.qty !== undefined && (!Number.isSafeInteger(item.qty) || item.qty < 1)) return null;
    if (seen.has(item.productId)) continue;
    seen.add(item.productId);
    out.push(item.qty === undefined ? { productId: item.productId } : { productId: item.productId, qty: item.qty });
  }
  return out;
}
