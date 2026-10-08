import { expect, test } from "vitest";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import en from "../../messages/en.json";
import { DAILY_QUOTE_COUNT, businessHour, firstName, greetingKey, homeAttention, quoteIndex } from "./home-briefing";

type Summary = FunctionReturnType<typeof api.home.summary>;

const t = (key: string, values: Record<string, string | number> = {}) => {
  const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en.Home);
  return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** A summary where nothing needs attention, with overrides. */
const summary = (o: Partial<Summary> = {}): Summary =>
  ({
    today: "2026-10-08",
    currency: "USD",
    approvalsWaiting: 0,
    stock: { low: 0, out: 0, unitsOnHand: 10 },
    batchesToReceive: 0,
    productsToConfirm: 0,
    requisitionsToBuy: 0,
    requisitionsOpen: 0,
    productsActive: 3,
    payroll: null,
    withdrawals: null,
    creditOwed: { amount: 0, customers: 0 },
    salesToday: { amount: 5000, lastSaleDay: null },
    monthToDate: null,
    ...o,
  }) as Summary;
const rows = (s: Summary, ctx: Partial<{ hour: number; canRecordSales: boolean }> = {}) =>
  homeAttention(s, { service: "hair", hour: 10, canRecordSales: true, t, money, ...ctx }).map((r) => [r.key, r.label, r.count ?? null, r.severity]);

test("greeting by the business hour, and the first name", () => {
  expect([greetingKey(0), greetingKey(11), greetingKey(12), greetingKey(17), greetingKey(18), greetingKey(23)]).toEqual([
    "morning",
    "morning",
    "afternoon",
    "afternoon",
    "evening",
    "evening",
  ]);
  // 05:30 UTC is 07:30 in Lubumbashi (UTC+2), whatever the machine's zone.
  expect(businessHour(Date.UTC(2026, 9, 8, 5, 30))).toBe(7);
  expect(businessHour(Date.UTC(2026, 9, 8, 22, 30))).toBe(0);
  expect(firstName("  Baraka   Danny ", "b@x.com")).toBe("Baraka");
  expect(firstName("", "aline.k@example.com")).toBe("aline.k");
});

test("the daily quote is stable for a day, moves on the next, and wraps", () => {
  const today = quoteIndex("2026-10-08");
  expect(quoteIndex("2026-10-08")).toBe(today);
  expect(quoteIndex("2026-10-09")).toBe((today % DAILY_QUOTE_COUNT) + 1);
  const all = new Set(Array.from({ length: DAILY_QUOTE_COUNT }, (_, i) => quoteIndex(`2026-01-${String(i + 1).padStart(2, "0")}`)));
  expect(all.size).toBe(DAILY_QUOTE_COUNT);
  expect(Math.min(...all)).toBe(1);
  expect(Math.max(...all)).toBe(DAILY_QUOTE_COUNT);
  for (let i = 1; i <= DAILY_QUOTE_COUNT; i++) expect(t(`quotes.q${i}`)).not.toContain("undefined");
});

test("nothing pending: no rows (All caught up)", () => {
  expect(rows(summary())).toEqual([]);
});

test("rows in order of urgency, with their severity", () => {
  expect(
    rows(
      summary({
        stock: { low: 2, out: 1, unitsOnHand: 5 },
        approvalsWaiting: 4,
        creditOwed: { amount: 47700, customers: 5 },
        batchesToReceive: 1,
        productsToConfirm: 3,
        requisitionsToBuy: 2,
      }),
    ),
  ).toEqual([
    ["out", "Out of stock", "1", "danger"],
    ["low", "Low stock", "2", "warning"],
    ["approvals", "Review pending approvals", "4", "warning"],
    ["credit", "Customers owe money", "$477.00", "warning"],
    ["receive", "Update stock for a recent purchase", "1", "neutral"],
    ["products", "Products to confirm", "3", "neutral"],
    ["requisitions", "Requisitions ready to buy", "2", "neutral"],
  ]);
});

test("'Record today's sales': sellers only, nothing sold today, from 16:00", () => {
  const none = summary({ salesToday: { amount: 0, lastSaleDay: "2026-10-05" } });
  expect(rows(none, { hour: 16 })).toEqual([["recordSales", "Record today's sales", null, "warning"]]);
  expect(rows(none, { hour: 15 })).toEqual([]);
  expect(rows(none, { hour: 18, canRecordSales: false })).toEqual([]);
  expect(rows(summary(), { hour: 18 })).toEqual([]); // already sold today
});
