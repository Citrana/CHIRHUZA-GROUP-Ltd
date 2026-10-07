import { percentChange } from "./analytics-compare";

/** next-intl's `t` for the "Analytics" namespace. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

type Totals = { sales: number; margin: number; expenses: number; payroll: number; netProfit: number };

/** A highlight, and whether it calls for attention (shown tinted) or is just a fact. */
export type Insight = { text: string; tone: "warning" | "info" };

/** Costs taking this share of the margin (or more) is a warning. */
export const COST_WARNING_PCT = 90;

/**
 * Up to 3 one-line highlights for the period, from figures the page has
 * already loaded (rollups only): when sales stopped, how much of the margin
 * costs took, the trend vs the previous period, and the top product's share.
 */
export function analyticsInsights(
  input: {
    summary: Totals;
    previous: Totals | null;
    /** Daily points (only used when the chart is per day). */
    points: Array<{ start: string; sales: number }>;
    granularity: "day" | "week" | "month";
    today: string;
    topProduct: { label: string; revenue: number } | null;
  },
  { t, formatDay }: { t: Translate; formatDay: (day: string) => string },
): Insight[] {
  const { summary, previous, points, granularity, today, topProduct } = input;
  const out: Insight[] = [];
  const warn = (text: string) => out.push({ text, tone: "warning" });
  const info = (text: string) => out.push({ text, tone: "info" });

  // When sales stopped.
  if (summary.sales === 0) {
    warn(t("insights.noSalesPeriod"));
  } else if (granularity === "day" && points.some((p) => p.start === today)) {
    const last = [...points].reverse().find((p) => p.sales > 0 && p.start <= today);
    if (last && last.start < today) warn(t("insights.noSalesSince", { date: formatDay(last.start) }));
  }

  // What costs took out of the margin.
  if (summary.sales > 0) {
    if (summary.margin <= 0) {
      warn(t("insights.negativeMargin"));
    } else {
      const costs = summary.expenses + summary.payroll;
      const pct = Math.round((costs / summary.margin) * 100);
      if (costs > 0) (pct >= COST_WARNING_PCT ? warn : info)(t("insights.costShare", { pct }));
    }
  }

  // The trend vs the previous period: net profit, else sales.
  if (previous) {
    const net = percentChange(summary.netProfit, previous.netProfit);
    const sales = percentChange(summary.sales, previous.sales);
    if (net !== null && Math.abs(net) >= 1) {
      (net > 0 ? info : warn)(t(net > 0 ? "insights.netUp" : "insights.netDown", { pct: Math.abs(Math.round(net)) }));
    } else if (sales !== null && Math.abs(sales) >= 1) {
      (sales > 0 ? info : warn)(t(sales > 0 ? "insights.salesUp" : "insights.salesDown", { pct: Math.abs(Math.round(sales)) }));
    }
  }

  // How much the best-selling product weighs.
  if (summary.sales > 0 && topProduct && topProduct.revenue > 0) {
    info(t("insights.topShare", { product: topProduct.label, pct: Math.round((topProduct.revenue / summary.sales) * 100) }));
  }
  return out.slice(0, 3);
}
