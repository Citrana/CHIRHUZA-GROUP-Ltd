import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

const summary = (s: Setup, who: Id<"users">) => s.as(who).query(api.home.summary, { businessUnitKey: "hair" });

test("each section only for those who may see it; counts match the pages", async () => {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);

  // The batch has arrived: the receiving side sees it; the agent sees nothing of stock.
  expect((await summary(s, s.manager)).batchesToReceive).toBe(1);
  const agent = await summary(s, s.agent);
  expect(agent).toMatchObject({ stock: null, batchesToReceive: null, productsToConfirm: null, requisitionsToBuy: null, monthToDate: null });

  await receiveAll(s, b.batchId);
  await s.approvedRequisition([[s.p4, 1]]);
  const chief = await summary(s, s.chief);
  const buyer = await summary(s, s.inventory);

  // The buyer's inline product waits for confirmation by a chief - never by its creator.
  expect(chief.productsToConfirm).toBe(1);
  expect(buyer.productsToConfirm).toBeNull();
  // A requisition approved and not yet in a batch: ready to buy, for the buyer.
  expect(buyer.requisitionsToBuy).toBe(1);
  expect(chief.requisitionsToBuy).toBeNull();
  // Same low / out counts as the Stock page.
  const counts = await s.as(s.chief).query(api.inventory.statusCounts, { businessUnitKey: "hair" });
  const overview = await s.as(s.chief).query(api.inventory.overview, { businessUnitKey: "hair" });
  expect(chief.stock).toEqual({
    low: counts.low,
    out: counts.out,
    unitsOnHand: overview.byProduct.reduce((t, p) => t + p.qty, 0),
  });
  // Card figures: active products (the buyer's pending one isn't), open requisitions.
  expect(chief.productsActive).toBe(4);
  // Requisition A is fully bought (closed); B is still purchasing; the new one is approved.
  expect(buyer.requisitionsOpen).toBe(2);
  expect(chief.batchesToReceive).toBeNull();
  // Approvals waiting: the same number as the sidebar badge.
  expect(chief.approvalsWaiting).toBe(await s.as(s.chief).query(api.approvals.pendingCount, { businessUnitKey: "hair" }));
});

test("today's sales, the last sale day, month-to-date net profit and credit owed - scoped", async () => {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const other = await insertLocation(s.t, { name: "Other Shop" });
  const lot = (await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  )).find((l) => l.sourceStockBatchItemId === b.i1._id)!._id;
  await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    for (const [to, qty] of [[s.shop, 6], [other, 2]] as const) {
      await applyMovement(ctx, {
        type: "distribute",
        inventoryBatchId: lot,
        fromHolderId: business,
        toHolderId: await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: to }),
        qty,
        refTable: "test",
        refId: "setup",
        actorId: s.chief,
      });
    }
  });
  const today = businessDayOf(Date.now());
  const sell = (who: Id<"users">, extra: object) =>
    s.as(who).mutation(api.sales.create, {
      businessUnitKey: "hair",
      paymentMethod: "cash",
      lines: [{ inventoryBatchId: lot, qty: 1, unitPrice: 500 }],
      ...extra,
    });

  // Nothing sold yet.
  expect((await summary(s, s.chief)).salesToday).toEqual({ amount: 0, lastSaleDay: null });

  // A sale yesterday only: today 0, last sale yesterday.
  const yesterday = addBusinessDays(today, -1);
  await sell(s.agent, { soldOn: yesterday });
  expect((await summary(s, s.agent)).salesToday).toEqual({ amount: 0, lastSaleDay: yesterday });

  // Today: $5 at the agent's shop, $5 at the other shop, plus a $5 credit sale ($2 paid).
  await sell(s.agent, {});
  await sell(s.sales, { locationId: other });
  const customerId = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Mama Neema" });
  await sell(s.agent, { paymentMethod: "credit", customerId, paidNow: 200, paidNowMethod: "cash" });

  const chief = await summary(s, s.chief);
  expect(chief.salesToday).toEqual({ amount: 1500, lastSaleDay: null });
  expect(chief.creditOwed).toEqual({ amount: 300, customers: 1 });
  // Month to date (cost $2 a piece; the batch's trip expenses count as business costs).
  const analytics = await s.as(s.chief).query(api.analytics.getSummary, {
    businessUnitKey: "hair",
    range: { preset: "month" },
  });
  expect(chief.monthToDate).toEqual({ sales: analytics.sales, netProfit: analytics.netProfit });

  // Payroll and withdrawals: totals for their .view holders; only your own pending otherwise.
  await s.as(s.agent).mutation(api.payroll.create, {
    businessUnitKey: "hair",
    workerName: "Neema",
    period: today.slice(0, 7),
    amount: 15_000,
  });
  await s.as(s.agent).mutation(api.withdrawals.create, { businessUnitKey: "hair", amount: 2_000, reason: "Family" });
  expect(await summary(s, s.chief)).toMatchObject({
    payroll: { paidThisMonth: analytics.payroll },
    withdrawals: { thisMonth: analytics.withdrawals },
  });
  // The agent has no payroll.view (salaries are private): only their own pending entry.
  // They do view withdrawals for their shop: that shop's total (still pending, so $0).
  expect(await summary(s, s.agent)).toMatchObject({ payroll: { minePending: 1 }, withdrawals: { thisMonth: 0 } });
  expect(await summary(s, s.manager)).toMatchObject({ payroll: { minePending: 0 } });

  // The own-location agent: only their shop (2 sales today = $10), no analytics.
  const agent = await summary(s, s.agent);
  expect(agent.salesToday).toEqual({ amount: 1000, lastSaleDay: null });
  expect(agent.monthToDate).toBeNull();
  expect(agent.creditOwed).toEqual({ amount: 300, customers: 1 });
});
