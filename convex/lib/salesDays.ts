import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { addBusinessDays } from "./time";

/**
 * Missing sales days: a shop's past open day with no sale recorded for a
 * service, and not marked "Closed / no sales" (closedSalesDays). The ONE
 * place this is worked out - Analytics and Home both call salesDaysFor.
 * Sales come from the dailyFinance rollups, never raw sales. Shops only:
 * warehouses don't sell. Days are YYYY-MM-DD in Africa/Lubumbashi.
 */

/** Monday to Saturday (0 = Sunday ... 6 = Saturday). */
export const DEFAULT_OPEN_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];
export const MAX_CLOSED_NOTE_LENGTH = 200;

/** The weekday of a day: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function openDaysOf(location: Pick<Doc<"locations">, "openDays">): readonly number[] {
  return location.openDays ?? DEFAULT_OPEN_DAYS;
}

/** Open days as stored: whole weekdays 0-6, sorted, no repeats, at least one. */
export function cleanOpenDays(days: readonly number[]): number[] {
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ConvexError("Open days must be weekdays.");
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length === 0) throw new ConvexError("Pick at least one open day.");
  return unique;
}

export type DayStatus =
  | "sale" // something was sold
  | "missing" // past open day, nothing sold, not marked closed
  | "marked_closed" // marked "Closed / no sales"
  | "closed_weekday" // the shop doesn't open that weekday
  | "before_start" // before the shop's first sale for the service
  | "today"; // not over yet: never flagged

/** What each day from `from` to `to` was for one shop (see DayStatus). */
export function classifyDays(input: {
  from: string;
  to: string;
  today: string;
  openDays: readonly number[];
  /** The shop's first day with a sale for the service; null = never sold. */
  firstDay: string | null;
  soldDays: ReadonlySet<string>;
  closedDays: ReadonlySet<string>;
}): Array<{ day: string; status: DayStatus }> {
  const out: Array<{ day: string; status: DayStatus }> = [];
  for (let day = input.from; day <= input.to && day <= input.today; day = addBusinessDays(day, 1)) {
    const status: DayStatus = input.soldDays.has(day)
      ? "sale"
      : day === input.today
        ? "today"
        : input.firstDay === null || day < input.firstDay
          ? "before_start"
          : !input.openDays.includes(weekdayOf(day))
            ? "closed_weekday"
            : input.closedDays.has(day)
              ? "marked_closed"
              : "missing";
    out.push({ day, status });
  }
  return out;
}

/** Whether a rollup row shows a sale (exchanges can net revenue to 0, never the cost). */
export function rowHasSale(row: Pick<Doc<"dailyFinance">, "sales" | "saleCost">): boolean {
  return row.sales !== 0 || row.saleCost !== 0;
}

/** How far the first-sale lookup reads (a shop's rows start with its first sales). */
const FIRST_DAY_SCAN = 400;

/** The shop's first day with a sale for the unit, or null. */
async function firstSaleDay(ctx: QueryCtx, unitId: Id<"businessUnits">, locationId: Id<"locations">): Promise<string | null> {
  const rows = await ctx.db
    .query("dailyFinance")
    .withIndex("by_key", (q) => q.eq("businessUnitId", unitId).eq("locationKey", locationId))
    .take(FIRST_DAY_SCAN);
  return rows.find(rowHasSale)?.day ?? null;
}

/** The "Closed / no sales" marks of a shop for the unit in a range (active ones). */
export async function closedMarks(
  ctx: QueryCtx,
  unitId: Id<"businessUnits">,
  locationId: Id<"locations">,
  from: string,
  to: string,
) {
  const rows = await ctx.db
    .query("closedSalesDays")
    .withIndex("by_unit_location_day", (q) =>
      q.eq("businessUnitId", unitId).eq("locationId", locationId).gte("day", from).lte("day", to),
    )
    .take(400);
  return rows.filter((r) => r.active);
}

/** The shops a missing-days view covers: the chosen one (if a shop), or every active shop. */
export async function trackedShops(ctx: QueryCtx, locationId: Id<"locations"> | null): Promise<Doc<"locations">[]> {
  if (locationId) {
    const location = await ctx.db.get("locations", locationId);
    return location && location.type === "shop" ? [location] : [];
  }
  const all = await ctx.db.query("locations").take(500);
  return all.filter((l) => l.type === "shop" && l.active).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Each shop's days from `from` to `to` for a unit, the missing ones and
 * the ones marked closed (with their note). Bounded: one range read per
 * shop (ranges are at most a year).
 */
export async function salesDaysFor(
  ctx: QueryCtx,
  unitId: Id<"businessUnits">,
  shops: Doc<"locations">[],
  from: string,
  to: string,
  today: string,
) {
  const perShop = [];
  const missing: Array<{ locationId: Id<"locations">; name: string; day: string }> = [];
  const marked: Array<{ locationId: Id<"locations">; name: string; day: string; note: string | null }> = [];
  for (const shop of shops) {
    const rows = await ctx.db
      .query("dailyFinance")
      .withIndex("by_key", (q) => q.eq("businessUnitId", unitId).eq("locationKey", shop._id).gte("day", from).lte("day", to))
      .take(400);
    const marks = await closedMarks(ctx, unitId, shop._id, from, to);
    const notes = new Map(marks.map((m) => [m.day, m.note ?? null]));
    const days = classifyDays({
      from,
      to,
      today,
      openDays: openDaysOf(shop),
      firstDay: await firstSaleDay(ctx, unitId, shop._id),
      soldDays: new Set(rows.filter(rowHasSale).map((r) => r.day)),
      closedDays: new Set(notes.keys()),
    });
    for (const { day, status } of days) {
      if (status === "missing") missing.push({ locationId: shop._id, name: shop.name, day });
      if (status === "marked_closed") marked.push({ locationId: shop._id, name: shop.name, day, note: notes.get(day) ?? null });
    }
    perShop.push({ locationId: shop._id, days });
  }
  // Most recent first: the days still easy to fix come at the top.
  const recentFirst = (a: { day: string; name: string }, b: { day: string; name: string }) =>
    b.day.localeCompare(a.day) || a.name.localeCompare(b.name);
  missing.sort(recentFirst);
  marked.sort(recentFirst);
  return { perShop, missing, marked };
}

/**
 * The chart's view of each day over several shops: `missing` when any shop
 * missed it, `closed` when no shop had it open (closed weekday or marked).
 */
export function chartDays(perShop: Array<{ days: Array<{ day: string; status: DayStatus }> }>) {
  const byDay = new Map<string, DayStatus[]>();
  for (const shop of perShop) {
    for (const { day, status } of shop.days) byDay.set(day, [...(byDay.get(day) ?? []), status]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, statuses]) => ({
      day,
      missing: statuses.includes("missing"),
      closed: statuses.every((s) => s === "closed_weekday" || s === "marked_closed"),
    }));
}
