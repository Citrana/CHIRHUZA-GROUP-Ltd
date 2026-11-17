import { ConvexError, v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ALL, daysBetween, monthStart, resolveRange, weekStart } from "./analytics";
import { comparableRange } from "./analyticsCompare";
import { approvalTypeValidator, type ApprovalType } from "./approvalTypes";
import { saleBalance } from "./credit";
import { currencyValidator, isMoneyField, usdValidator, type Currency } from "./money";
import { isPermissionKey, type PermissionKey } from "./permissions";
import { productDetails } from "./products";
import { salesDaysFor, trackedShops, weekdayOf } from "./salesDays";
import { addBusinessDays, businessDayOf, businessDayStartUtc } from "./time";

/**
 * Reports (CLAUDE.md "Reports"): a read-only summary of a service for a
 * period, saved as history. Scheduled reports run from convex/crons.ts
 * (reports:runDue); custom ones are generated on demand. Building a report
 * only READS: it never changes money, stock or any business record.
 * Days are YYYY-MM-DD in Africa/Lubumbashi; money is USD cents.
 */

// ------------------------------------------------------------- validators

export const REPORT_SECTIONS = ["sales", "missingDays", "stock", "approvals", "credit", "cash"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const reportSectionValidator = v.union(
  v.literal("sales"),
  v.literal("missingDays"),
  v.literal("stock"),
  v.literal("approvals"),
  v.literal("credit"),
  v.literal("cash"),
);

export const reportFrequencyValidator = v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly"));
export type ReportFrequency = Infer<typeof reportFrequencyValidator>;

export const reportChannelValidator = v.union(v.literal("in_app"), v.literal("email"));
export type ReportChannel = Infer<typeof reportChannelValidator>;
/** Channels that work today. Email needs a provider first (shown "coming soon"). */
export const AVAILABLE_CHANNELS: readonly ReportChannel[] = ["in_app"];

export const reportKindValidator = v.union(v.literal("scheduled"), v.literal("custom"));
export const reportStatusValidator = v.union(v.literal("ready"), v.literal("failed"));

/** Only owners of cash.view see the cash section (cash stays owner-only). */
export const SECTION_PERMISSION: Partial<Record<ReportSection, PermissionKey>> = { cash: "cash.view" };

const stockItem = v.object({
  productId: v.id("products"),
  name: v.string(),
  sku: v.string(),
  lengthInches: v.union(v.number(), v.null()),
  sizeName: v.union(v.string(), v.null()),
  colourName: v.union(v.string(), v.null()),
  onHand: v.number(),
  outOfStockSince: v.union(v.number(), v.null()),
  // Optional below: reports saved before they existed don't have them.
  sold30: v.optional(v.number()),
  reorderQty: v.optional(v.number()),
});

/** The money figures of a period, from the dailyFinance rollups (USD cents). */
const financeFigures = v.object({
  sales: v.number(),
  margin: v.number(),
  expenses: v.number(),
  payroll: v.number(),
  netProfit: v.number(),
  // Shown apart, never subtracted from profit.
  withdrawals: v.number(),
});
export type FinanceFigures = Infer<typeof financeFigures>;

/**
 * What a report shows, saved with it (a snapshot: it never changes later).
 * Fields marked optional were added later: older reports open without them.
 */
export const reportContentValidator = v.object({
  sales: v.optional(
    v.object({
      total: v.number(),
      // The previous period of the same length; null when not compared
      // (too short, or nothing recorded in it).
      previousTotal: v.union(v.number(), v.null()),
      compareFrom: v.union(v.string(), v.null()),
      compareTo: v.union(v.string(), v.null()),
      currency: usdValidator,
      figures: v.optional(financeFigures),
      previous: v.optional(v.union(financeFigures, v.null())),
      byShop: v.optional(v.array(v.object({ locationId: v.id("locations"), name: v.string(), sales: v.number() }))),
      topProducts: v.optional(
        v.array(
          v.object({
            productId: v.id("products"),
            name: v.string(),
            lengthInches: v.union(v.number(), v.null()),
            sizeName: v.union(v.string(), v.null()),
            colourName: v.union(v.string(), v.null()),
            unitsSold: v.number(),
            revenue: v.number(),
            margin: v.number(),
          }),
        ),
      ),
      // Shop-days with no sales in the period: totals may be understated.
      missingDaysCount: v.optional(v.number()),
    }),
  ),
  missingDays: v.optional(
    v.object({
      count: v.number(),
      shops: v.array(
        v.object({
          locationId: v.id("locations"),
          name: v.string(),
          days: v.array(v.string()),
          count: v.optional(v.number()),
          // Only the latest MAX_LISTED_MISSING_DAYS dates kept (long periods).
          truncated: v.optional(v.boolean()),
        }),
      ),
    }),
  ),
  stock: v.optional(
    v.object({
      lowCount: v.number(),
      outCount: v.number(),
      low: v.array(stockItem),
      out: v.array(stockItem),
      // All stock at purchase cost (the Stock page's figure), and its units.
      value: v.optional(v.number()),
      unitsOnHand: v.optional(v.number()),
    }),
  ),
  approvals: v.optional(
    v.object({
      count: v.number(),
      byType: v.array(v.object({ type: approvalTypeValidator, count: v.number() })),
      items: v.optional(
        v.array(
          v.object({
            approvalId: v.id("approvals"),
            type: approvalTypeValidator,
            amount: v.union(v.number(), v.null()),
            currency: v.union(currencyValidator, v.null()),
            requestedByName: v.string(),
            requestedAt: v.number(),
          }),
        ),
      ),
    }),
  ),
  credit: v.optional(
    v.object({
      totalOwed: v.number(),
      customers: v.number(),
      top: v.array(
        v.object({
          customerId: v.id("customers"),
          name: v.string(),
          balance: v.number(),
          oldestUnpaidAt: v.optional(v.number()),
          daysUnpaid: v.optional(v.number()),
        }),
      ),
      currency: usdValidator,
    }),
  ),
  cash: v.optional(
    v.object({
      onHand: v.number(),
      pendingOpeningCash: v.number(),
      pendingOpeningCashCount: v.number(),
      currency: usdValidator,
    }),
  ),
});
export type ReportContent = Infer<typeof reportContentValidator>;

// --------------------------------------------------------------- schedule

export type Schedule = {
  frequency: ReportFrequency;
  /** 0 = Sunday ... 6 = Saturday (weekly). */
  dayOfWeek: number;
  /** 1-28 (monthly): every month has it. */
  dayOfMonth: number;
  /** "HH:MM", Lubumbashi time, in 15-minute steps (the cron's pace). */
  time: string;
};

export const DEFAULT_SCHEDULE: Schedule = { frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, time: "09:00" };
export const MINUTE_STEP = 15;
export const MAX_RECIPIENTS = 20;
/** Capped lists keep a report small; the counts are always complete. */
export const MAX_STOCK_ITEMS = 100;
export const MAX_TOP_CUSTOMERS = 20;
export const TOP_PRODUCTS = 5;
export const MAX_APPROVAL_ITEMS = 50;
/** Periods longer than this list only the latest MAX_LISTED_MISSING_DAYS dates per shop. */
export const LONG_PERIOD_DAYS = 31;
export const MAX_LISTED_MISSING_DAYS = 14;
/** Reorder suggestions cover this many days of sales. */
export const SOLD_WINDOW_DAYS = 30;
const MAX_STATS_ROWS = 20_000;
const MAX_LEVELS = 5000;
export const RETRY_DELAY_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 2;
const MAX_ROWS = 2000;
const MAX_ROLLUP_DAYS = 20_000;

/** Minutes after midnight for a valid "HH:MM" on the 15-minute grid, else null. */
export function parseTime(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes % MINUTE_STEP === 0 ? minutes : null;
}

export function assertSchedule(s: Schedule) {
  if (parseTime(s.time) === null) throw new ConvexError("Pick a time on the quarter hour (for example 09:00).");
  if (!Number.isInteger(s.dayOfWeek) || s.dayOfWeek < 0 || s.dayOfWeek > 6) throw new ConvexError("Pick a day of the week.");
  if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > 28) {
    throw new ConvexError("Pick a day of the month from 1 to 28.");
  }
}

function runsOn(s: Schedule, day: string): boolean {
  if (s.frequency === "daily") return true;
  if (s.frequency === "weekly") return weekdayOf(day) === s.dayOfWeek;
  return Number(day.slice(8, 10)) === s.dayOfMonth;
}

/** The next moment (UTC ms) after `now` the schedule fires, in Lubumbashi time. */
export function nextRunAt(s: Schedule, now: number): number {
  const minutes = parseTime(s.time) ?? 9 * 60;
  const today = businessDayOf(now);
  for (let i = 0; i <= 62; i++) {
    const day = addBusinessDays(today, i);
    const at = businessDayStartUtc(day) + minutes * 60_000;
    if (runsOn(s, day) && at > now) return at;
  }
  throw new Error("No run day found in two months.");
}

/**
 * The period a scheduled report run on `runDay` covers:
 * - daily: the day before;
 * - weekly: Monday to Sunday - the week ending that day when it runs on a
 *   Sunday (the default: Sunday 09:00), otherwise the last full week;
 * - monthly: the previous calendar month.
 */
export function periodFor(frequency: ReportFrequency, runDay: string): { from: string; to: string } {
  if (frequency === "daily") {
    const day = addBusinessDays(runDay, -1);
    return { from: day, to: day };
  }
  if (frequency === "weekly") {
    const to = weekdayOf(runDay) === 0 ? runDay : addBusinessDays(weekStart(runDay), -1);
    return { from: addBusinessDays(to, -6), to };
  }
  const to = addBusinessDays(monthStart(runDay), -1);
  return { from: monthStart(to), to };
}

/** The previous period of the same length, or null (fewer than 3 days: not compared). */
export function compareRangeFor(from: string, to: string): { from: string; to: string } | null {
  return comparableRange("custom", from, to);
}

/** A custom report's range: real dates, from <= to, not in the future, at most 12 months. */
export function customRange(from: string, to: string, now: number): { from: string; to: string } {
  return resolveRange({ from, to }, now);
}

/** Sections in catalogue order, no repeats, at least one. */
export function cleanSections(sections: readonly ReportSection[]): ReportSection[] {
  const clean = REPORT_SECTIONS.filter((s) => sections.includes(s));
  if (clean.length === 0) throw new ConvexError("Pick at least one section.");
  return clean;
}

/** The sections a user may see, from their permissions. */
export function visibleSections(
  sections: readonly ReportSection[],
  can: (key: PermissionKey) => boolean,
): ReportSection[] {
  return sections.filter((s) => {
    const key = SECTION_PERMISSION[s];
    return key === undefined || can(key);
  });
}

/** A report's content limited to what the viewer may see. */
export function contentFor(content: ReportContent, can: (key: PermissionKey) => boolean): ReportContent {
  const out: ReportContent = { ...content };
  for (const section of REPORT_SECTIONS) {
    const key = SECTION_PERMISSION[section];
    if (key !== undefined && !can(key)) delete out[section];
  }
  return out;
}

// ----------------------------------------------------------- pure helpers

/** Consecutive days grouped into ranges: [10, 11, 12, 15] -> 10-12, 15-15. */
export function groupDayRanges(days: readonly string[]): Array<{ from: string; to: string }> {
  const sorted = [...new Set(days)].sort();
  const ranges: Array<{ from: string; to: string }> = [];
  for (const day of sorted) {
    const last = ranges.at(-1);
    if (last && addBusinessDays(last.to, 1) === day) last.to = day;
    else ranges.push({ from: day, to: day });
  }
  return ranges;
}

/**
 * Suggested reorder: enough to cover SOLD_WINDOW_DAYS of sales, and at least
 * the low-stock level, minus what's on hand. Never below 0.
 */
export function reorderQty(sold30: number, lowStockThreshold: number | undefined, onHand: number): number {
  return Math.max(Math.max(sold30, lowStockThreshold ?? 0) - Math.max(onHand, 0), 0);
}

/**
 * The amount an approval is about, from its payload (the Money rule: money
 * fields are `amount` / ...Amount / ...Total / ...Cost / ...Price, with
 * `currency` beside them). Prefers amount, then ...Amount, then ...Total.
 */
export function approvalAmount(payload: unknown): { amount: number; currency: Currency } | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const after = root.after && typeof root.after === "object" ? (root.after as Record<string, unknown>) : null;
  for (const source of [after, root]) {
    if (!source) continue;
    const keys = Object.keys(source).filter((k) => isMoneyField(k) && typeof source[k] === "number");
    const rank = (k: string) => (k === "amount" ? 0 : k.endsWith("Amount") ? 1 : k.endsWith("Total") ? 2 : 3);
    const key = keys.sort((a, b) => rank(a) - rank(b))[0];
    if (key) {
      const currency = source.currency === "CDF" || root.currency === "CDF" ? "CDF" : "USD";
      return { amount: source[key] as number, currency };
    }
  }
  return null;
}

/** Margin, net profit (margin - expenses - payroll) and withdrawals (apart) of rollup rows. */
export function financeFiguresOf(
  rows: ReadonlyArray<Pick<Doc<"dailyFinance">, "sales" | "saleCost" | "expenses" | "payroll" | "withdrawals">>,
): FinanceFigures {
  const sum = (f: "sales" | "saleCost" | "expenses" | "payroll" | "withdrawals") => rows.reduce((t, r) => t + r[f], 0);
  const margin = sum("sales") - sum("saleCost");
  return {
    sales: sum("sales"),
    margin,
    expenses: sum("expenses"),
    payroll: sum("payroll"),
    netProfit: margin - sum("expenses") - sum("payroll"),
    withdrawals: sum("withdrawals"),
  };
}

/** Whether rollup rows hold anything at all (else the period isn't compared). */
function hasFinanceData(rows: ReadonlyArray<Pick<Doc<"dailyFinance">, "sales" | "saleCost" | "expenses" | "payroll" | "withdrawals">>) {
  return rows.some((r) => r.sales !== 0 || r.saleCost !== 0 || r.expenses !== 0 || r.payroll !== 0 || r.withdrawals !== 0);
}

/** % change, one decimal; null without a previous figure. */
function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/**
 * The 3-4 plain lines at the top of a report, from its saved content (so
 * older reports get them too). Each line is a message key under
 * `Reports.highlights` and its values: `amount` is USD cents, the rest
 * are numbers. A line is left out when its section isn't in the report.
 */
export type Highlight =
  | { key: "salesUp" | "salesDown"; values: { amount: number; pct: number } }
  | { key: "salesFlat" | "salesTotal"; values: { amount: number } }
  | { key: "missing"; values: { days: number; shops: number } }
  | { key: "noMissing"; values: Record<string, never> }
  | { key: "reorder"; values: { products: number; units: number } }
  | { key: "noReorder"; values: Record<string, never> }
  | { key: "owed"; values: { amount: number; customers: number; days: number } }
  | { key: "noOwed"; values: Record<string, never> };

export function reportHighlights(content: ReportContent): Highlight[] {
  const out: Highlight[] = [];
  if (content.sales) {
    const amount = content.sales.figures?.sales ?? content.sales.total;
    const pct = content.sales.previousTotal !== null ? pctChange(amount, content.sales.previousTotal) : null;
    if (pct === null) out.push({ key: "salesTotal", values: { amount } });
    else if (pct === 0) out.push({ key: "salesFlat", values: { amount } });
    else out.push({ key: pct > 0 ? "salesUp" : "salesDown", values: { amount, pct: Math.abs(pct) } });
  }
  const missing = content.missingDays
    ? { days: content.missingDays.count, shops: content.missingDays.shops.length }
    : content.sales?.missingDaysCount !== undefined
      ? { days: content.sales.missingDaysCount, shops: null }
      : null;
  if (missing) {
    if (missing.days === 0) out.push({ key: "noMissing", values: {} });
    else out.push({ key: "missing", values: { days: missing.days, shops: missing.shops ?? 1 } });
  }
  if (content.stock) {
    const items = [...content.stock.low, ...content.stock.out];
    const toReorder = items.filter((i) => (i.reorderQty ?? 0) > 0);
    const hasSuggestions = items.some((i) => i.reorderQty !== undefined);
    const products = hasSuggestions ? toReorder.length : content.stock.lowCount + content.stock.outCount;
    if (products === 0) out.push({ key: "noReorder", values: {} });
    else out.push({ key: "reorder", values: { products, units: toReorder.reduce((t, i) => t + (i.reorderQty ?? 0), 0) } });
  }
  if (content.credit) {
    if (content.credit.customers === 0) out.push({ key: "noOwed", values: {} });
    else {
      const days = Math.max(0, ...content.credit.top.map((c) => c.daysUnpaid ?? 0));
      out.push({ key: "owed", values: { amount: content.credit.totalOwed, customers: content.credit.customers, days } });
    }
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- content

type Range = { from: string; to: string };

async function financeRows(ctx: QueryCtx, unitId: Id<"businessUnits">, locationKey: string, range: Range) {
  return await ctx.db
    .query("dailyFinance")
    .withIndex("by_key", (q) => q.eq("businessUnitId", unitId).eq("locationKey", locationKey).gte("day", range.from).lte("day", range.to))
    .take(daysBetween(range.from, range.to) + 1);
}

/** Units, revenue and margin per product over a range, from the dailyStats rollups (all locations). */
async function productSales(ctx: QueryCtx, unitId: Id<"businessUnits">, range: Range) {
  const rows = await ctx.db
    .query("dailyStats")
    .withIndex("by_unit_location_day", (q) => q.eq("businessUnitId", unitId).eq("locationKey", ALL).gte("day", range.from).lte("day", range.to))
    .take(MAX_STATS_ROWS);
  const byProduct = new Map<Id<"products">, { unitsSold: number; revenue: number; margin: number }>();
  for (const row of rows) {
    const p = byProduct.get(row.productId) ?? { unitsSold: 0, revenue: 0, margin: 0 };
    p.unitsSold += row.unitsSold;
    p.revenue += row.revenue;
    p.margin += row.margin;
    byProduct.set(row.productId, p);
  }
  return byProduct;
}

async function stockItems(ctx: QueryCtx, rows: Doc<"productStock">[], sold30: Map<Id<"products">, { unitsSold: number }>) {
  const items = [];
  for (const row of rows.slice(0, MAX_STOCK_ITEMS)) {
    const product = await ctx.db.get("products", row.productId);
    if (!product) continue;
    const details = await productDetails(ctx, product);
    const sold = Math.max(sold30.get(row.productId)?.unitsSold ?? 0, 0);
    items.push({
      productId: row.productId,
      name: product.name,
      sku: product.sku,
      ...details,
      onHand: row.onHand,
      outOfStockSince: row.outOfStockSince ?? null,
      sold30: sold,
      reorderQty: reorderQty(sold, product.lowStockThreshold, row.onHand),
    });
  }
  // Most to reorder first, then by name.
  return items.sort((a, b) => b.reorderQty - a.reorderQty || a.name.localeCompare(b.name));
}

/** All stock held, at purchase cost (lot unit cost), and its units. Bounded. */
async function stockValue(ctx: QueryCtx, unitId: Id<"businessUnits">) {
  const levels = await ctx.db
    .query("stockLevels")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unitId))
    .take(MAX_LEVELS);
  const costs = new Map<Id<"inventoryBatches">, number>();
  let value = 0;
  let units = 0;
  for (const level of levels) {
    if (level.qtyOnHand <= 0) continue;
    if (!costs.has(level.inventoryBatchId)) {
      costs.set(level.inventoryBatchId, (await ctx.db.get("inventoryBatches", level.inventoryBatchId))?.unitCost ?? 0);
    }
    value += level.qtyOnHand * costs.get(level.inventoryBatchId)!;
    units += level.qtyOnHand;
  }
  return { value, units };
}

/**
 * Builds a report's content for a unit and a period. Read-only. The period
 * covers sales and missing days; stock, approvals, money owed and cash are
 * "as of now" (they have no history).
 */
async function buildReportContent(
  ctx: QueryCtx,
  unitId: Id<"businessUnits">,
  range: Range,
  sections: readonly ReportSection[],
  now: number,
): Promise<ReportContent> {
  const today = businessDayOf(now);
  const want = new Set(sections);
  const content: ReportContent = {};
  const shops = await trackedShops(ctx, null);

  // Open days only, "Closed / no sales" days left out: salesDaysFor. Also
  // needed by Sales (its totals may be understated).
  const missing =
    want.has("sales") || want.has("missingDays")
      ? (await salesDaysFor(ctx, unitId, shops, range.from, range.to, today)).missing
      : [];

  if (want.has("sales")) {
    const compare = compareRangeFor(range.from, range.to);
    const figures = financeFiguresOf(await financeRows(ctx, unitId, ALL, range));
    const previousRows = compare ? await financeRows(ctx, unitId, ALL, compare) : [];
    // Compared only when the period before holds data.
    const previous = compare && hasFinanceData(previousRows) ? financeFiguresOf(previousRows) : null;

    const byShop = [];
    for (const shop of shops) {
      byShop.push({ locationId: shop._id, name: shop.name, sales: financeFiguresOf(await financeRows(ctx, unitId, shop._id, range)).sales });
    }
    const ranked = [...(await productSales(ctx, unitId, range)).entries()]
      .filter(([, p]) => p.unitsSold > 0)
      .sort((a, b) => b[1].revenue - a[1].revenue || b[1].unitsSold - a[1].unitsSold)
      .slice(0, TOP_PRODUCTS);
    const topProducts = [];
    for (const [productId, p] of ranked) {
      const product = await ctx.db.get("products", productId);
      const details = await productDetails(ctx, product);
      topProducts.push({ productId, name: product?.name ?? "?", ...details, ...p });
    }

    content.sales = {
      total: figures.sales,
      previousTotal: previous?.sales ?? null,
      compareFrom: previous ? compare!.from : null,
      compareTo: previous ? compare!.to : null,
      currency: "USD",
      figures,
      previous,
      byShop: byShop.sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name)),
      topProducts,
      missingDaysCount: missing.length,
    };
  }

  if (want.has("missingDays")) {
    const long = daysBetween(range.from, range.to) > LONG_PERIOD_DAYS;
    const byShop = new Map<Id<"locations">, { locationId: Id<"locations">; name: string; days: string[] }>();
    for (const m of missing) {
      const entry = byShop.get(m.locationId) ?? { locationId: m.locationId, name: m.name, days: [] };
      entry.days.push(m.day);
      byShop.set(m.locationId, entry);
    }
    content.missingDays = {
      count: missing.length,
      shops: [...byShop.values()]
        .map((s) => {
          const days = s.days.sort();
          const truncated = long && days.length > MAX_LISTED_MISSING_DAYS;
          return { ...s, count: days.length, days: truncated ? days.slice(-MAX_LISTED_MISSING_DAYS) : days, truncated };
        })
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }

  if (want.has("stock")) {
    const rows = (status: "low" | "out") =>
      ctx.db
        .query("productStock")
        .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unitId).eq("status", status))
        .take(MAX_ROWS);
    const [low, out] = [await rows("low"), await rows("out")];
    const sold30 = await productSales(ctx, unitId, { from: addBusinessDays(today, -(SOLD_WINDOW_DAYS - 1)), to: today });
    const { value, units } = await stockValue(ctx, unitId);
    content.stock = {
      lowCount: low.length,
      outCount: out.length,
      low: await stockItems(ctx, low, sold30),
      out: await stockItems(ctx, out, sold30),
      value,
      unitsOnHand: units,
    };
  }

  if (want.has("approvals")) {
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unitId).eq("status", "pending"))
      .order("desc")
      .take(MAX_ROWS);
    const counts = new Map<ApprovalType, number>();
    for (const a of pending) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    const names = new Map<Id<"users">, string>();
    const items = [];
    for (const a of pending.slice(0, MAX_APPROVAL_ITEMS)) {
      if (!names.has(a.requestedBy)) names.set(a.requestedBy, (await ctx.db.get("users", a.requestedBy))?.name ?? "?");
      const money = approvalAmount(a.payload);
      items.push({
        approvalId: a._id,
        type: a.type,
        amount: money?.amount ?? null,
        currency: money?.currency ?? null,
        requestedByName: names.get(a.requestedBy)!,
        requestedAt: a._creationTime,
      });
    }
    content.approvals = {
      count: pending.length,
      byType: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      items,
    };
  }

  if (want.has("credit")) {
    const open = (
      await ctx.db
        .query("sales")
        .withIndex("by_businessUnitId_and_creditStatus", (q) => q.eq("businessUnitId", unitId).eq("creditStatus", "open"))
        .take(MAX_ROWS)
    ).filter((s) => s.customerId);
    // Like credit.owed: balance per customer and their oldest unpaid sale.
    const perCustomer = new Map<Id<"customers">, { balance: number; oldestUnpaidAt: number }>();
    for (const sale of open) {
      const row = perCustomer.get(sale.customerId!) ?? { balance: 0, oldestUnpaidAt: sale.createdAt };
      row.balance += saleBalance(sale);
      row.oldestUnpaidAt = Math.min(row.oldestUnpaidAt, sale.createdAt);
      perCustomer.set(sale.customerId!, row);
    }
    const ranked = [...perCustomer.entries()]
      .filter(([, r]) => r.balance > 0)
      .sort((a, b) => a[1].oldestUnpaidAt - b[1].oldestUnpaidAt || b[1].balance - a[1].balance)
      .slice(0, MAX_TOP_CUSTOMERS);
    const top = [];
    for (const [customerId, r] of ranked) {
      const customer = await ctx.db.get("customers", customerId);
      top.push({
        customerId,
        name: customer?.name ?? "?",
        balance: r.balance,
        oldestUnpaidAt: r.oldestUnpaidAt,
        daysUnpaid: daysBetween(businessDayOf(r.oldestUnpaidAt), today) - 1,
      });
    }
    const owing = [...perCustomer.values()].filter((r) => r.balance > 0);
    content.credit = {
      totalOwed: owing.reduce((t, r) => t + r.balance, 0),
      customers: owing.length,
      top,
      currency: "USD",
    };
  }

  if (want.has("cash")) {
    // Same sum as cash.onHand (all locations, every day up to today), plus
    // opening cash still waiting for approval (not counted in cash yet).
    const rows = await ctx.db
      .query("dailyFinance")
      .withIndex("by_key", (q) => q.eq("businessUnitId", unitId).eq("locationKey", ALL).lte("day", today))
      .take(MAX_ROLLUP_DAYS);
    const onHand = rows.reduce(
      (t, r) =>
        t + (r.openingCash ?? 0) + (r.cashSales ?? 0) + (r.cashCreditPayments ?? 0) - (r.cashRefunds ?? 0) - r.withdrawals,
      0,
    );
    const pending = (
      await ctx.db
        .query("openingCash")
        .withIndex("by_businessUnitId_and_date", (q) => q.eq("businessUnitId", unitId))
        .order("desc")
        .take(MAX_ROWS)
    ).filter((r) => r.status === "pending");
    content.cash = {
      onHand,
      pendingOpeningCash: pending.reduce((t, r) => t + (r.kind === "reversal" ? -r.amount : r.amount), 0),
      pendingOpeningCashCount: pending.length,
      currency: "USD",
    };
  }

  return content;
}

/** Kept on an object so tests can make a run fail (vi.spyOn). */
export const reportBuilder = { build: buildReportContent };

// ------------------------------------------------------------- recipients

/** Active users whose role holds `key` (bounded). */
export async function usersWithPermission(ctx: QueryCtx, key: PermissionKey): Promise<Doc<"users">[]> {
  if (!isPermissionKey(key)) return [];
  const permission = await ctx.db
    .query("permissions")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!permission) return [];
  const links = await ctx.db
    .query("rolePermissions")
    .withIndex("by_permissionId", (q) => q.eq("permissionId", permission._id))
    .take(100);
  const users: Doc<"users">[] = [];
  for (const link of links) {
    const holders = await ctx.db
      .query("users")
      .withIndex("by_roleId", (q) => q.eq("roleId", link.roleId))
      .take(500);
    users.push(...holders.filter((u) => u.status === "active"));
  }
  return users.sort((a, b) => a.name.localeCompare(b.name));
}
