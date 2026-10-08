import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { BUSINESS_TIME_ZONE } from "../../convex/lib/time";

/**
 * The Home briefing's logic (pure, unit-tested): the greeting, the quote
 * of the day and the "Needs attention" rows. Times are in the business
 * time zone (Africa/Lubumbashi), never the browser's.
 */

type Summary = FunctionReturnType<typeof api.home.summary>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The single switch for the daily quote under the greeting. */
export const SHOW_DAILY_QUOTE = true;
/** How many quotes there are (Home.quotes.q1 … qN in the message files). */
export const DAILY_QUOTE_COUNT = 30;

/** Hour of the day (0-23) in the business time zone. */
export function businessHour(now: number): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: BUSINESS_TIME_ZONE }).format(now);
  return Number(hour);
}

export function greetingKey(hour: number): "morning" | "afternoon" | "evening" {
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

/** The first word of the user's name, or the start of their email. */
export function firstName(name: string | undefined | null, email: string | undefined | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first || (email ?? "").split("@")[0] || "";
}

/** The quote number (1-based) for a business day: same all day, the next one tomorrow. */
export function quoteIndex(day: string): number {
  const days = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  return (((days % DAILY_QUOTE_COUNT) + DAILY_QUOTE_COUNT) % DAILY_QUOTE_COUNT) + 1;
}

/** After this business hour, a seller with no sale today is reminded to record them. */
export const RECORD_SALES_REMINDER_HOUR = 16;

export type AttentionRow = {
  key: string;
  href: string;
  label: string;
  count?: string;
  severity: "danger" | "warning" | "neutral";
};

/**
 * The "Needs attention" rows: what's actionable now for this user, most
 * urgent first. Each row comes from live data (or the time of day), so it
 * disappears once resolved. The summary only holds what the user may see.
 */
export function homeAttention(
  summary: Summary,
  ctx: { service: string; hour: number; canRecordSales: boolean; t: Translate; money: (cents: number) => string },
): AttentionRow[] {
  const { service, t } = ctx;
  const rows: AttentionRow[] = [];
  const at = (path: string) => `/${service}${path}`;

  if (summary.stock?.out) {
    rows.push({ key: "out", href: at("/stock?status=out"), label: t("attention.outOfStock"), count: String(summary.stock.out), severity: "danger" });
  }
  if (summary.stock?.low) {
    rows.push({ key: "low", href: at("/stock?status=low"), label: t("attention.lowStock"), count: String(summary.stock.low), severity: "warning" });
  }
  if (summary.approvalsWaiting > 0) {
    rows.push({ key: "approvals", href: at("/approvals"), label: t("attention.reviewApprovals"), count: String(summary.approvalsWaiting), severity: "warning" });
  }
  if (ctx.canRecordSales && summary.salesToday && summary.salesToday.amount === 0 && ctx.hour >= RECORD_SALES_REMINDER_HOUR) {
    rows.push({ key: "recordSales", href: at("/sales/new"), label: t("attention.recordSales"), severity: "warning" });
  }
  if (summary.creditOwed && summary.creditOwed.amount > 0) {
    rows.push({ key: "credit", href: at("/sales/credit"), label: t("attention.credit"), count: ctx.money(summary.creditOwed.amount), severity: "warning" });
  }
  if (summary.batchesToReceive) {
    rows.push({ key: "receive", href: at("/stock/batches"), label: t("attention.receiveStock"), count: String(summary.batchesToReceive), severity: "neutral" });
  }
  if (summary.productsToConfirm) {
    rows.push({ key: "products", href: at("/products"), label: t("attention.products"), count: String(summary.productsToConfirm), severity: "neutral" });
  }
  if (summary.requisitionsToBuy) {
    rows.push({ key: "requisitions", href: at("/requisitions"), label: t("attention.requisitions"), count: String(summary.requisitionsToBuy), severity: "neutral" });
  }
  return rows;
}
