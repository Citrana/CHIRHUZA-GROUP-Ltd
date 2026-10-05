import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { addBusinessDays, businessDayOf, isBusinessDay } from "./time";

/**
 * Analytics rollups (CLAUDE.md "Analytics"). Charts and summaries read
 * pre-aggregated daily rows - never raw sales:
 * - dailyStats: per (unit, locationKey, product, business day): units sold,
 *   revenue, cost, margin;
 * - dailyFinance: per (unit, locationKey, business day): sales, sale cost,
 *   expenses, payroll, withdrawals.
 * `locationKey` is a location id, NONE for business-level money (trip
 * expenses, payroll/withdrawals without a location), or ALL: every change
 * is also added to the ALL row, so "All locations" reads one row per day.
 *
 * `applyRollupEvent` (via the event builders below) is the ONLY writer,
 * called in the same mutation as the source change. Voids and edits apply
 * the reversed event (sign -1). `rebuildRollups` recomputes everything from
 * raw data with the same `computeRollups`, so the two always agree.
 * Money: USD cents. Margin = price - purchase cost (unitCostSnapshot).
 */

export const ALL = "*";
export const NONE = "none";

export const FINANCE_FIELDS = ["sales", "saleCost", "expenses", "payroll", "withdrawals"] as const;
export type FinanceField = (typeof FINANCE_FIELDS)[number];
export type FinanceDelta = Partial<Record<FinanceField, number>>;
export type ProductDelta = { productId: Id<"products">; units: number; revenue: number; cost: number };

/** One change to the rollups: at a location (or business-level), on a day. */
export type RollupEvent = {
  locationId: Id<"locations"> | null;
  day: string;
  finance?: FinanceDelta;
  product?: ProductDelta;
};

// ---------------------------------------------------------- event builders

/** A sale's rollup events (sign -1 reverses it, for voids/edits). */
export function saleEvents(
  sale: Pick<Doc<"sales">, "locationId" | "createdAt">,
  items: Pick<Doc<"saleItems">, "productId" | "qty" | "unitPrice" | "unitCostSnapshot">[],
  sign: 1 | -1 = 1,
): RollupEvent[] {
  const day = businessDayOf(sale.createdAt);
  const events: RollupEvent[] = items.map((item) => ({
    locationId: sale.locationId,
    day,
    product: {
      productId: item.productId,
      units: sign * item.qty,
      revenue: sign * item.unitPrice * item.qty,
      cost: sign * item.unitCostSnapshot * item.qty,
    },
  }));
  events.push({
    locationId: sale.locationId,
    day,
    finance: {
      sales: sign * items.reduce((s, i) => s + i.unitPrice * i.qty, 0),
      saleCost: sign * items.reduce((s, i) => s + i.unitCostSnapshot * i.qty, 0),
    },
  });
  return events;
}

/** A trip expense (business-level) on the day it was recorded. */
export function expenseEvent(expense: Pick<Doc<"stockBatchExpenses">, "_creationTime">, amountDelta: number): RollupEvent {
  return { locationId: null, day: businessDayOf(expense._creationTime), finance: { expenses: amountDelta } };
}

/** An approved payroll entry, on the day it was approved. */
export function payrollEvent(entry: Pick<Doc<"payrollEntries">, "locationId" | "amount">, decidedAt: number): RollupEvent {
  return { locationId: entry.locationId ?? null, day: businessDayOf(decidedAt), finance: { payroll: entry.amount } };
}

/** An approved withdrawal, on the day the cash was taken. */
export function withdrawalEvent(withdrawal: Pick<Doc<"withdrawals">, "locationId" | "amount" | "date">): RollupEvent {
  return {
    locationId: withdrawal.locationId ?? null,
    day: businessDayOf(withdrawal.date),
    finance: { withdrawals: withdrawal.amount },
  };
}

// ----------------------------------------------------------------- writes

const keysFor = (locationId: Id<"locations"> | null) => [locationId ?? NONE, ALL];

const financeIsZero = (row: Record<FinanceField, number>) => FINANCE_FIELDS.every((f) => row[f] === 0);

/**
 * THE writer: adds an event's deltas to its location row (or NONE) and to
 * the ALL row, in the caller's mutation. A row that comes back to all zeros
 * is removed, so rollups always equal a fresh recomputation.
 */
export async function applyRollupEvent(ctx: MutationCtx, businessUnitId: Id<"businessUnits">, event: RollupEvent) {
  for (const locationKey of keysFor(event.locationId)) {
    if (event.finance) {
      const row = await ctx.db
        .query("dailyFinance")
        .withIndex("by_key", (q) => q.eq("businessUnitId", businessUnitId).eq("locationKey", locationKey).eq("day", event.day))
        .unique();
      const next = Object.fromEntries(
        FINANCE_FIELDS.map((f) => [f, (row?.[f] ?? 0) + (event.finance![f] ?? 0)]),
      ) as Record<FinanceField, number>;
      if (row) {
        if (financeIsZero(next)) await ctx.db.delete("dailyFinance", row._id);
        else await ctx.db.patch("dailyFinance", row._id, next);
      } else if (!financeIsZero(next)) {
        await ctx.db.insert("dailyFinance", { businessUnitId, locationKey, day: event.day, ...next });
      }
    }
    if (event.product) {
      const { productId, units, revenue, cost } = event.product;
      const row = await ctx.db
        .query("dailyStats")
        .withIndex("by_key", (q) =>
          q.eq("businessUnitId", businessUnitId).eq("locationKey", locationKey).eq("productId", productId).eq("day", event.day),
        )
        .unique();
      const next = {
        unitsSold: (row?.unitsSold ?? 0) + units,
        revenue: (row?.revenue ?? 0) + revenue,
        cost: (row?.cost ?? 0) + cost,
      };
      const values = { ...next, margin: next.revenue - next.cost };
      const zero = next.unitsSold === 0 && next.revenue === 0 && next.cost === 0;
      if (row) {
        if (zero) await ctx.db.delete("dailyStats", row._id);
        else await ctx.db.patch("dailyStats", row._id, values);
      } else if (!zero) {
        await ctx.db.insert("dailyStats", { businessUnitId, locationKey, productId, day: event.day, ...values });
      }
    }
  }
}

export async function applyRollupEvents(ctx: MutationCtx, businessUnitId: Id<"businessUnits">, events: RollupEvent[]) {
  for (const event of events) await applyRollupEvent(ctx, businessUnitId, event);
}

// ----------------------------------------------------- full recomputation

export type FinanceRow = { locationKey: string; day: string } & Record<FinanceField, number>;
export type StatsRow = {
  locationKey: string;
  productId: Id<"products">;
  day: string;
  unitsSold: number;
  revenue: number;
  cost: number;
  margin: number;
};

/** The rollup rows a list of events adds up to (pure; zero rows dropped). */
export function computeRollups(events: RollupEvent[]): { finance: FinanceRow[]; stats: StatsRow[] } {
  const finance = new Map<string, FinanceRow>();
  const stats = new Map<string, StatsRow>();
  for (const event of events) {
    for (const locationKey of keysFor(event.locationId)) {
      if (event.finance) {
        const key = `${locationKey}|${event.day}`;
        const row =
          finance.get(key) ??
          ({ locationKey, day: event.day, sales: 0, saleCost: 0, expenses: 0, payroll: 0, withdrawals: 0 } as FinanceRow);
        for (const f of FINANCE_FIELDS) row[f] += event.finance[f] ?? 0;
        finance.set(key, row);
      }
      if (event.product) {
        const key = `${locationKey}|${event.product.productId}|${event.day}`;
        const row =
          stats.get(key) ??
          ({ locationKey, productId: event.product.productId, day: event.day, unitsSold: 0, revenue: 0, cost: 0, margin: 0 } as StatsRow);
        row.unitsSold += event.product.units;
        row.revenue += event.product.revenue;
        row.cost += event.product.cost;
        row.margin = row.revenue - row.cost;
        stats.set(key, row);
      }
    }
  }
  return {
    finance: [...finance.values()].filter((r) => !financeIsZero(r)),
    stats: [...stats.values()].filter((r) => r.unitsSold !== 0 || r.revenue !== 0 || r.cost !== 0),
  };
}

const MAX_SOURCE_ROWS = 10_000;

/** Every rollup event of a unit, read back from the raw data. */
async function rawEvents(ctx: MutationCtx, businessUnitId: Id<"businessUnits">): Promise<RollupEvent[]> {
  const events: RollupEvent[] = [];
  const sales = await ctx.db
    .query("sales")
    .withIndex("by_businessUnitId_and_createdAt", (q) => q.eq("businessUnitId", businessUnitId))
    .take(MAX_SOURCE_ROWS);
  for (const sale of sales) {
    if (sale.status !== "completed") continue;
    const items = await ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", sale._id)).take(500);
    events.push(...saleEvents(sale, items));
  }
  const batches = await ctx.db
    .query("stockBatches")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", businessUnitId))
    .take(MAX_SOURCE_ROWS);
  for (const batch of batches) {
    const expenses = await ctx.db.query("stockBatchExpenses").withIndex("by_batchId", (q) => q.eq("batchId", batch._id)).take(500);
    for (const expense of expenses) events.push(expenseEvent(expense, expense.amount));
  }
  const payroll = await ctx.db
    .query("payrollEntries")
    .withIndex("by_businessUnitId_and_period", (q) => q.eq("businessUnitId", businessUnitId))
    .take(MAX_SOURCE_ROWS);
  for (const entry of payroll) {
    if (entry.status === "approved" && entry.decidedAt !== undefined) events.push(payrollEvent(entry, entry.decidedAt));
  }
  const withdrawals = await ctx.db
    .query("withdrawals")
    .withIndex("by_businessUnitId_and_date", (q) => q.eq("businessUnitId", businessUnitId))
    .take(MAX_SOURCE_ROWS);
  for (const withdrawal of withdrawals) {
    if (withdrawal.status === "approved") events.push(withdrawalEvent(withdrawal));
  }
  return events;
}

/**
 * Throws the unit's rollups away and rebuilds them from raw data (backfill,
 * or to repair). Bounded reads: fine at today's volumes; split into
 * paginated batches when a unit outgrows MAX_SOURCE_ROWS.
 */
export async function rebuildRollups(ctx: MutationCtx, businessUnitId: Id<"businessUnits">) {
  for (const row of await ctx.db
    .query("dailyFinance")
    .withIndex("by_key", (q) => q.eq("businessUnitId", businessUnitId))
    .take(50_000)) {
    await ctx.db.delete("dailyFinance", row._id);
  }
  for (const row of await ctx.db
    .query("dailyStats")
    .withIndex("by_unit_location_day", (q) => q.eq("businessUnitId", businessUnitId))
    .take(50_000)) {
    await ctx.db.delete("dailyStats", row._id);
  }
  const { finance, stats } = computeRollups(await rawEvents(ctx, businessUnitId));
  for (const row of finance) await ctx.db.insert("dailyFinance", { businessUnitId, ...row });
  for (const row of stats) await ctx.db.insert("dailyStats", { businessUnitId, ...row });
  return { financeRows: finance.length, statsRows: stats.length };
}

// ----------------------------------------------------------------- ranges

export type RangeInput = { preset: "today" | "week" | "month" } | { from: string; to: string };
export const MAX_RANGE_DAYS = 366;

/** Monday of the week containing `day`. */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addBusinessDays(day, -((weekday + 6) % 7));
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Number of days from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * A range as business days (Lubumbashi), from..to inclusive: today, this
 * week (Monday start), this month (to date), or a custom range (from <= to,
 * at most MAX_RANGE_DAYS, not in the future).
 */
export function resolveRange(range: RangeInput, now: number): { from: string; to: string } {
  const today = businessDayOf(now);
  if ("preset" in range) {
    if (range.preset === "today") return { from: today, to: today };
    if (range.preset === "week") return { from: weekStart(today), to: today };
    return { from: monthStart(today), to: today };
  }
  const { from, to } = range;
  if (!isBusinessDay(from) || !isBusinessDay(to)) throw new ConvexError("Dates must be YYYY-MM-DD.");
  if (from > to) throw new ConvexError("The start date must be before the end date.");
  if (to > today) throw new ConvexError("The range can't be in the future.");
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new ConvexError(`Pick at most ${MAX_RANGE_DAYS} days.`);
  return { from, to };
}

export type Granularity = "day" | "week" | "month";

/** The start of the bucket (day / Monday / 1st of month) a day falls in. */
export function bucketOf(day: string, granularity: Granularity): string {
  return granularity === "day" ? day : granularity === "week" ? weekStart(day) : monthStart(day);
}

/** Every bucket start from `from` to `to`, so charts show empty periods as 0. */
export function bucketsBetween(from: string, to: string, granularity: Granularity): string[] {
  const buckets: string[] = [];
  let day = bucketOf(from, granularity);
  while (day <= to) {
    buckets.push(day);
    day =
      granularity === "day"
        ? addBusinessDays(day, 1)
        : granularity === "week"
          ? addBusinessDays(day, 7)
          : (() => {
              const [y, m] = day.split("-").map(Number);
              return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
            })();
  }
  return buckets;
}
