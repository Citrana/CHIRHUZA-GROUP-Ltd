import { expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  ALL,
  NONE,
  bucketsBetween,
  cashPaymentEvent,
  computeRollups,
  exchangeEvents,
  openingCashEvent,
  resolveRange,
  saleEvents,
  weekStart,
  type RollupEvent,
} from "./analytics";

// Thursday 1 Oct 2026, 10:00 in Lubumbashi (08:00 UTC).
const NOW = Date.UTC(2026, 9, 1, 8, 0);

test("resolveRange: today, a Monday-start week across months, the month to date", () => {
  expect(resolveRange({ preset: "today" }, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  expect(resolveRange({ preset: "week" }, NOW)).toEqual({ from: "2026-09-28", to: "2026-10-01" });
  expect(resolveRange({ preset: "month" }, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  // 23:30 on 30 Sep in Lubumbashi is still September there.
  expect(resolveRange({ preset: "month" }, Date.UTC(2026, 8, 30, 21, 30))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday -> Monday before
  expect(weekStart("2026-09-28")).toBe("2026-09-28");
});

test("resolveRange: custom ranges are validated", () => {
  expect(resolveRange({ from: "2026-09-01", to: "2026-09-30" }, NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  expect(() => resolveRange({ from: "2026-09-30", to: "2026-09-01" }, NOW)).toThrow(/before the end/);
  expect(() => resolveRange({ from: "2026-09-01", to: "2026-10-02" }, NOW)).toThrow(/future/);
  expect(() => resolveRange({ from: "2025-09-01", to: "2026-09-30" }, NOW)).toThrow(/at most 366/);
  expect(() => resolveRange({ from: "2026/09/01", to: "2026-09-30" }, NOW)).toThrow(/YYYY-MM-DD/);
});

test("bucketsBetween fills every period", () => {
  expect(bucketsBetween("2026-09-29", "2026-10-02", "day")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  expect(bucketsBetween("2026-09-30", "2026-10-13", "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
  expect(bucketsBetween("2026-11-15", "2027-01-02", "month")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
});

// The cash-on-hand fields of a finance row (a cash sale's total is cash received).
const cash = (cashSales: number) => ({ cashSales, cashCreditPayments: 0, cashRefunds: 0, openingCash: 0 });

test("computeRollups adds to the location and to ALL, and drops rows that cancel out", () => {
  const shop = "shop1" as Id<"locations">;
  const p = "p1" as Id<"products">;
  const sale = { locationId: shop, createdAt: NOW, paymentMethod: "cash" as const };
  const items = [{ productId: p, qty: 2, unitPrice: 500, unitCostSnapshot: 200 }];
  const { finance, stats } = computeRollups([
    ...saleEvents(sale, items),
    { locationId: null, day: "2026-10-01", finance: { expenses: 300 } },
  ]);
  expect(finance).toEqual([
    { locationKey: shop, day: "2026-10-01", sales: 1000, saleCost: 400, expenses: 0, payroll: 0, withdrawals: 0, ...cash(1000) },
    { locationKey: ALL, day: "2026-10-01", sales: 1000, saleCost: 400, expenses: 300, payroll: 0, withdrawals: 0, ...cash(1000) },
    { locationKey: NONE, day: "2026-10-01", sales: 0, saleCost: 0, expenses: 300, payroll: 0, withdrawals: 0, ...cash(0) },
  ]);
  expect(stats.map((r) => [r.locationKey, r.unitsSold, r.margin])).toEqual([
    [shop, 2, 600],
    [ALL, 2, 600],
  ]);
  // A sale and its reversal cancel out completely.
  expect(computeRollups([...saleEvents(sale, items), ...saleEvents(sale, items, -1)])).toEqual({ finance: [], stats: [] });
});

test("cash events: exchanges settled in cash, cash credit payments and opening cash only touch the cash fields", () => {
  const shop = "shop1" as Id<"locations">;
  const p = "p1" as Id<"products">;
  const item = { productId: p, qty: 1, unitPrice: 500, unitCostSnapshot: 200 };
  const exchange = (differenceAmount: number, settlementMethod?: "cash" | "mobile_money") =>
    exchangeEvents({ locationId: shop, createdAt: NOW, differenceAmount, settlementMethod }, [item], [{ ...item, unitPrice: 500 + differenceAmount }]);
  const at = (events: RollupEvent[]) => computeRollups(events).finance.find((r) => r.locationKey === shop);
  expect(at(exchange(300, "cash"))).toMatchObject({ sales: 300, cashSales: 300, cashRefunds: 0 });
  expect(at(exchange(-200, "cash"))).toMatchObject({ sales: -200, cashSales: 0, cashRefunds: 200 });
  expect(at(exchange(300, "mobile_money"))).toMatchObject({ sales: 300, cashSales: 0, cashRefunds: 0 });
  // A mobile money sale is revenue but not cash.
  expect(at(saleEvents({ locationId: shop, createdAt: NOW, paymentMethod: "mobile_money" }, [item]))).toMatchObject({ sales: 500, cashSales: 0 });

  expect(cashPaymentEvent({ locationId: shop, amount: 400, method: "mobile_money", paidAt: NOW })).toBeNull();
  const payment = cashPaymentEvent({ locationId: shop, amount: 400, method: "cash", paidAt: NOW })!;
  const opening = openingCashEvent({ locationId: undefined, amount: 1000, date: NOW, kind: "record" });
  const reversal = openingCashEvent({ locationId: undefined, amount: 1000, date: NOW, kind: "reversal" });
  const { finance } = computeRollups([payment, opening]);
  expect(finance.find((r) => r.locationKey === ALL)).toMatchObject({ sales: 0, cashCreditPayments: 400, openingCash: 1000 });
  expect(computeRollups([opening, reversal]).finance).toEqual([]);
});
