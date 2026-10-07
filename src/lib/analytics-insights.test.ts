import { expect, test } from "vitest";
import en from "../../messages/en.json";
import { analyticsInsights } from "./analytics-insights";

const t = (key: string, values: Record<string, string | number> = {}) => {
  const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en.Analytics);
  return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};
const formatDay = (day: string) => `day ${day}`;
const totals = (o: Partial<{ sales: number; margin: number; expenses: number; payroll: number; netProfit: number }>) => ({
  sales: 0,
  margin: 0,
  expenses: 0,
  payroll: 0,
  netProfit: 0,
  ...o,
});
const points = [
  { start: "2026-10-05", sales: 15000 },
  { start: "2026-10-06", sales: 0 },
  { start: "2026-10-07", sales: 0 },
];

test("sales stopped, costs share of margin, net trend; at most 3", () => {
  const out = analyticsInsights(
    {
      summary: totals({ sales: 182600, margin: 81000, expenses: 51000, payroll: 27000, netProfit: 3000 }),
      previous: totals({ sales: 100000, margin: 40000, netProfit: 5000 }),
      points,
      granularity: "day",
      today: "2026-10-07",
      topProduct: { label: "Bob", revenue: 29400 },
    },
    { t, formatDay },
  );
  expect(out).toEqual([
    { text: "No sales since day 2026-10-05", tone: "warning" },
    // 96% is at or above the 90% warning line.
    { text: "Expenses and payroll took 96% of the margin", tone: "warning" },
    { text: "Net profit down 40% vs previous period", tone: "warning" },
  ]);
});

test("no sales at all; negative margin; sales trend when net isn't comparable; top product share", () => {
  expect(
    analyticsInsights(
      { summary: totals({}), previous: null, points, granularity: "day", today: "2026-10-07", topProduct: null },
      { t, formatDay },
    ),
  ).toEqual([{ text: "No sales in this period", tone: "warning" }]);
  expect(
    analyticsInsights(
      {
        summary: totals({ sales: 10000, margin: -500, netProfit: -500 }),
        previous: totals({ sales: 8000, netProfit: 0 }),
        points: [{ start: "2026-10-07", sales: 10000 }],
        granularity: "day",
        today: "2026-10-07",
        topProduct: { label: "Wig Cap", revenue: 2500 },
      },
      { t, formatDay },
    ),
  ).toEqual([
    { text: "Margin is negative this period", tone: "warning" },
    { text: "Sales up 25% vs previous period", tone: "info" },
    { text: "Wig Cap brought 25% of revenue", tone: "info" },
  ]);
});

test("costs below 90% of the margin and a rising net are just facts", () => {
  const out = analyticsInsights(
    {
      summary: totals({ sales: 100000, margin: 50000, expenses: 20000, payroll: 5000, netProfit: 25000 }),
      previous: totals({ sales: 90000, netProfit: 20000 }),
      points: [{ start: "2026-10-07", sales: 100000 }],
      granularity: "day",
      today: "2026-10-07",
      topProduct: null,
    },
    { t, formatDay },
  );
  expect(out).toEqual([
    { text: "Expenses and payroll took 50% of the margin", tone: "info" },
    { text: "Net profit up 25% vs previous period", tone: "info" },
  ]);
});
