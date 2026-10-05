import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { applyRollupEvents, saleEvents } from "./lib/analytics";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * The mixed batch received, then at Goma Shop 6 × P1 ($2 cost) and 3 × P2
 * ($10 cost), and 2 × P1 at Other Shop. Then:
 * - sales today at Goma Shop: 2 × P1 @ $5, 1 × P2 @ $15; at Other Shop:
 *   1 × P1 @ $7; yesterday at Goma Shop (backdated): 1 × P1 @ $6;
 * - trip expenses (today): freight $8 -> $10, meals $3 removed, transport $20;
 * - payroll: $150 approved (Goma Shop), $80 pending, $60 rejected;
 * - withdrawals: $50 approved (Goma Shop), $25 pending.
 */
async function scenario() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const other = await insertLocation(s.t, { name: "Other Shop" });
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const p1Lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!._id;
  const p2Lot = lots.find((l) => l.sourceStockBatchItemId === b.i2._id)!._id;
  await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    const move = async (lot: Id<"inventoryBatches">, to: Id<"locations">, qty: number) =>
      applyMovement(ctx, {
        type: "distribute",
        inventoryBatchId: lot,
        fromHolderId: business,
        toHolderId: await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: to }),
        qty,
        refTable: "test",
        refId: "setup",
        actorId: s.chief,
      });
    await move(p1Lot, s.shop, 6);
    await move(p2Lot, s.shop, 3);
    await move(p1Lot, other, 2);
  });

  const today = businessDayOf(Date.now());
  const yesterday = addBusinessDays(today, -1);
  const sell = (who: Id<"users">, lines: { inventoryBatchId: Id<"inventoryBatches">; qty: number; unitPrice: number; discountReason?: string }[], extra: object = {}) =>
    s.as(who).mutation(api.sales.create, { businessUnitKey: "hair", paymentMethod: "cash", lines, ...extra });
  await sell(s.agent, [
    { inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 },
    { inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 },
  ]);
  await sell(s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 700 }], { locationId: other });
  await sell(s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 600 }], { soldOn: yesterday });

  const expenses = await s.t.run((ctx) =>
    ctx.db.query("stockBatchExpenses").withIndex("by_batchId", (q) => q.eq("batchId", b.batchId)).collect(),
  );
  const freight = expenses.find((e) => e.category === "freight")!;
  const meals = expenses.find((e) => e.category === "meals")!;
  await s.as(s.inventory).mutation(api.stockBatches.updateExpense, { expenseId: freight._id, category: "freight", amount: 1000 });
  await s.as(s.inventory).mutation(api.stockBatches.removeExpense, { expenseId: meals._id });
  await s.as(s.inventory).mutation(api.stockBatches.addExpense, { batchId: b.batchId, category: "transport", amount: 2000 });

  const payroll = (amount: number) =>
    s.as(s.agent).mutation(api.payroll.create, { businessUnitKey: "hair", workerName: "Neema", period: today.slice(0, 7), amount });
  const decide = async (table: "payrollEntries" | "withdrawals", id: string, decision: "approve" | "reject") => {
    const doc = await s.t.run((ctx) => ctx.db.get(table as "payrollEntries", id as Id<"payrollEntries">));
    await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: doc!.approvalId!, decision });
  };
  await decide("payrollEntries", await payroll(15_000), "approve");
  await payroll(8_000);
  await decide("payrollEntries", await payroll(6_000), "reject");
  const withdrawal = (amount: number, who = s.agent) =>
    s.as(who).mutation(api.withdrawals.create, { businessUnitKey: "hair", amount, reason: "Family" });
  await decide("withdrawals", await withdrawal(5_000), "approve");
  await withdrawal(2_500, s.inventory);

  return { s, other, today, yesterday, p1Lot, p2Lot };
}

const summary = (s: Setup, range: object, locationId?: Id<"locations">, who = s.chief) =>
  s.as(who).query(api.analytics.getSummary, {
    businessUnitKey: "hair",
    range: range as { preset: "today" },
    ...(locationId ? { locationId } : {}),
  });

test("getSummary: exact figures for all locations and per shop", async () => {
  const { s, other, today, yesterday } = await scenario();
  expect(await summary(s, { from: today, to: today })).toMatchObject({
    sales: 3200,
    cost: 1600,
    margin: 1600,
    marginPct: 50,
    expenses: 3000, // freight 10 + transport 20 (meals removed)
    payroll: 15_000, // pending and rejected don't count
    withdrawals: 5_000, // shown apart, never subtracted
    netProfit: 1600 - 3000 - 15_000,
  });
  expect(await summary(s, { from: yesterday, to: yesterday })).toMatchObject({ sales: 600, cost: 200, margin: 400, expenses: 0 });
  // Per shop: trip expenses are business-level, so not in a shop's figures.
  expect(await summary(s, { from: today, to: today }, s.shop)).toMatchObject({
    sales: 2500,
    margin: 1100,
    expenses: 0,
    payroll: 15_000,
    withdrawals: 5_000,
  });
  expect(await summary(s, { from: yesterday, to: today }, other)).toMatchObject({ sales: 700, margin: 500, payroll: 0 });
  expect((await summary(s, { preset: "today" })).sales).toBe(3200);
});

test("getTopProducts and getTimeSeries", async () => {
  const { s, today, yesterday } = await scenario();
  const top = (by: "units" | "margin", order: "asc" | "desc") =>
    s.as(s.chief).query(api.analytics.getTopProducts, { businessUnitKey: "hair", range: { from: yesterday, to: today }, by, order });
  const mostSold = await top("units", "desc");
  expect(mostSold.products.map((p) => [p.name, p.unitsSold, p.revenue, p.margin])).toEqual([
    ["P1", 4, 2300, 1500],
    ["P2", 1, 1500, 500],
  ]);
  expect((await top("units", "asc")).products.map((p) => p.name)).toEqual(["P2", "P1"]);
  expect((await top("margin", "desc")).products.map((p) => p.name)).toEqual(["P1", "P2"]);

  const series = await s.as(s.chief).query(api.analytics.getTimeSeries, {
    businessUnitKey: "hair",
    range: { from: addBusinessDays(yesterday, -1), to: today },
    granularity: "day",
  });
  expect(series.points).toEqual([
    { start: addBusinessDays(yesterday, -1), sales: 0, margin: 0, expenses: 0, payroll: 0, withdrawals: 0 },
    { start: yesterday, sales: 600, margin: 400, expenses: 0, payroll: 0, withdrawals: 0 },
    { start: today, sales: 3200, margin: 1600, expenses: 3000, payroll: 15_000, withdrawals: 5_000 },
  ]);
  const monthly = await s.as(s.chief).query(api.analytics.getTimeSeries, {
    businessUnitKey: "hair",
    range: { from: yesterday, to: today },
    granularity: "month",
  });
  expect(monthly.points.reduce((t, p) => t + p.sales, 0)).toBe(3800);
});

test("the rollups equal a full recomputation from raw data", async () => {
  const { s } = await scenario();
  const snapshot = () =>
    s.t.run(async (ctx) => {
      const strip = <T extends { _id: unknown; _creationTime: unknown }>({ _id, _creationTime, ...rest }: T) => {
        void _id;
        void _creationTime;
        return JSON.stringify(rest);
      };
      return {
        finance: (await ctx.db.query("dailyFinance").collect()).map(strip).sort(),
        stats: (await ctx.db.query("dailyStats").collect()).map(strip).sort(),
      };
    });
  const incremental = await snapshot();
  expect(incremental.finance.length).toBeGreaterThan(0);
  expect(incremental.stats.length).toBeGreaterThan(0);
  const result = await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  expect(result).toEqual({ financeRows: incremental.finance.length, statsRows: incremental.stats.length });
  expect(await snapshot()).toEqual(incremental);
});

test("a reversed sale (void/edit delta) brings the figures back", async () => {
  const { s, today, p1Lot } = await scenario();
  const before = await summary(s, { from: today, to: today });
  const { saleId } = await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 900 }],
  });
  expect((await summary(s, { from: today, to: today })).sales).toBe(before.sales + 900);
  await s.t.run(async (ctx) => {
    const sale = (await ctx.db.get("sales", saleId))!;
    const items = await ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect();
    await applyRollupEvents(ctx, sale.businessUnitId, saleEvents(sale, items, -1));
  });
  expect(await summary(s, { from: today, to: today })).toEqual(before);
});

test("access: analytics.view required; own_location viewers see only their shop", async () => {
  const { s, other, today } = await scenario();
  await expect(summary(s, { preset: "today" }, undefined, s.agent)).rejects.toThrow(/analytics\.view/);
  await expect(summary(s, { preset: "today" }, undefined, s.manager)).rejects.toThrow(/analytics\.view/);
  await s.t.run(async (ctx) => {
    const roleId = (await ctx.db.get("users", s.agent))!.roleId!;
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "analytics.view")!;
    await ctx.db.insert("rolePermissions", { roleId, permissionId: permission._id, scope: "own_location" });
  });
  // Asking for another shop still returns the agent's own shop.
  expect(await summary(s, { from: today, to: today }, other, s.agent)).toMatchObject({ sales: 2500, payroll: 15_000 });
  expect(await s.as(s.agent).query(api.analytics.filterLocations, { businessUnitKey: "hair" })).toMatchObject({
    locked: true,
    locations: [{ name: "Goma Shop" }],
  });
});

const productSales = (s: Setup, range: object, locationId?: Id<"locations">, who = s.chief) =>
  s.as(who).query(api.analytics.getProductSales, {
    businessUnitKey: "hair",
    range: range as { preset: "today" },
    ...(locationId ? { locationId } : {}),
  });
const rowsOf = (report: Awaited<ReturnType<typeof productSales>>) =>
  report.rows.map((r) => [r.name, r.unitsSold, r.revenue, r.cost, r.margin, r.marginPct]);

test("getProductSales: every product sold, with totals matching the summary", async () => {
  const { s, other, today, yesterday } = await scenario();
  const day = await productSales(s, { from: today, to: today });
  expect(rowsOf(day)).toEqual([
    ["P1", 3, 1700, 600, 1100, 64.7],
    ["P2", 1, 1500, 1000, 500, 33.3],
  ]);
  const totals = await summary(s, { from: today, to: today });
  expect(day.totals).toEqual({ unitsSold: 4, revenue: totals.sales, cost: totals.cost, margin: totals.margin });
  expect(day).toMatchObject({ from: today, to: today, currency: "USD", truncated: false });

  // One day, one shop.
  expect(rowsOf(await productSales(s, { from: yesterday, to: yesterday }, s.shop))).toEqual([["P1", 1, 600, 200, 400, 66.7]]);
  expect(rowsOf(await productSales(s, { from: today, to: today }, other))).toEqual([["P1", 1, 700, 200, 500, 71.4]]);
  expect((await productSales(s, { from: addBusinessDays(yesterday, -1), to: addBusinessDays(yesterday, -1) })).rows).toEqual([]);
});

test("getProductSales access: analytics.view required; own_location viewers see only their shop", async () => {
  const { s, other, today } = await scenario();
  await expect(productSales(s, { preset: "today" }, undefined, s.agent)).rejects.toThrow(/analytics\.view/);
  await s.t.run(async (ctx) => {
    const roleId = (await ctx.db.get("users", s.agent))!.roleId!;
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "analytics.view")!;
    await ctx.db.insert("rolePermissions", { roleId, permissionId: permission._id, scope: "own_location" });
  });
  expect(rowsOf(await productSales(s, { from: today, to: today }, other, s.agent))).toEqual([
    ["P1", 2, 1000, 400, 600, 60],
    ["P2", 1, 1500, 1000, 500, 33.3],
  ]);
});

test("only convex/lib/analytics.ts writes the rollup tables", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true });
  const writes = /\.(insert|patch|replace|delete)\(\s*["'`](dailyStats|dailyFinance)["'`]/;
  const offenders = Object.entries(sources)
    .filter(([path]) => !path.includes("_generated") && !path.endsWith(".test.ts") && path !== "./lib/analytics.ts")
    .filter(([, source]) => writes.test(source as string))
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});
