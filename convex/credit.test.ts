import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { appendOnlyGuardedDb } from "./lib/rbac";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * Goma Shop holds 6 of P1 ($2.00 cost) and 3 of P2 ($10.00 cost); Other
 * Shop holds 2 of P1. The agent sells at Goma Shop (own_location).
 */
async function withShopStock() {
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
  const customer = (name: string, who = s.agent, phone?: string) =>
    s.as(who).mutation(api.customers.create, { businessUnitKey: "hair", name, ...(phone ? { phone } : {}) });
  return { s, other, p1Lot, p2Lot, customer };
}

type Line = { inventoryBatchId: Id<"inventoryBatches">; qty: number; unitPrice: number };
const creditSale = (
  s: Setup,
  who: Id<"users">,
  customerId: Id<"customers">,
  lines: Line[],
  extra: Partial<{
    locationId: Id<"locations">;
    agreedTotal: number;
    saleDiscountReason: string;
    paidNow: number;
    paidNowMethod: "cash" | "mobile_money";
  }> = {},
) => s.as(who).mutation(api.sales.create, { businessUnitKey: "hair", paymentMethod: "credit", customerId, lines, ...extra });

const getSale = (s: Setup, id: Id<"sales">) => s.t.run((ctx) => ctx.db.get("sales", id));
const getCustomer = (s: Setup, id: Id<"customers">) => s.t.run((ctx) => ctx.db.get("customers", id));

/** Rollup rows without ids, comparable before and after a rebuild. */
const rollups = (s: Setup) =>
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

test("a credit sale: agreed total with a reason, part paid now, the rest owed", async () => {
  const { s, p1Lot, p2Lot, customer } = await withShopStock();
  const neema = await customer("Mama Neema", s.agent, "0990 000 111");
  const lines = [
    { inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 },
    { inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 },
  ];

  // The agreed total can't exceed the lines, and below them needs a reason.
  await expect(creditSale(s, s.agent, neema, lines, { agreedTotal: 2600 })).rejects.toThrow(/can't be more/);
  const err = await creditSale(s, s.agent, neema, lines, { agreedTotal: 2200 }).then(() => null, (e) => e);
  expect(err.data).toMatchObject({ code: "SALE_DISCOUNT_REASON" });
  await expect(creditSale(s, s.agent, neema, lines, { paidNow: 3000, paidNowMethod: "cash" })).rejects.toThrow(/from 0 up to the total/);
  await expect(creditSale(s, s.agent, neema, lines, { paidNow: 100 })).rejects.toThrow(/how the customer paid/);
  // Only a credit sale has a customer or a part payment.
  await expect(
    s.as(s.agent).mutation(api.sales.create, { businessUnitKey: "hair", paymentMethod: "cash", customerId: neema, lines }),
  ).rejects.toThrow(/Only a credit sale/);

  const { saleId } = await creditSale(s, s.agent, neema, lines, {
    agreedTotal: 2200,
    saleDiscountReason: "Bought three pieces",
    paidNow: 700,
    paidNowMethod: "cash",
  });
  expect(await getSale(s, saleId)).toMatchObject({
    customerName: "Mama Neema",
    linesTotal: 2500,
    totalAmount: 2200,
    saleDiscountReason: "Bought three pieces",
    amountPaid: 700,
    creditStatus: "open",
  });
  const items = await s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
  expect(items.map((i) => i.saleDiscountShare)).toEqual([120, 180]);
  expect((await getCustomer(s, neema))!.balance).toBe(1500);
  const payments = await s.t.run((ctx) => ctx.db.query("salePayments").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
  expect(payments).toMatchObject([{ amount: 700, method: "cash", kind: "at_sale", customerId: neema }]);

  // Analytics: revenue is the agreed total, split over the products.
  const today = businessDayOf(Date.now());
  const range = { from: today, to: today };
  const summary = await s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey: "hair", range });
  expect(summary).toMatchObject({ sales: 2200, cost: 1400, margin: 800 });
  const report = await s.as(s.chief).query(api.analytics.getProductSales, { businessUnitKey: "hair", range });
  expect(report.rows.map((r) => [r.name, r.revenue])).toEqual([
    ["P1", 880],
    ["P2", 1320],
  ]);
  const incremental = await rollups(s);
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  expect(await rollups(s)).toEqual(incremental);

  // The sales list shows the balance and the payments.
  const list = await s.as(s.agent).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: { numItems: 10, cursor: null } });
  expect(list.page[0]).toMatchObject({ balance: 1500, payments: [{ amount: 700, kind: "at_sale" }] });
});

test("a credit sale paid in full at once is settled; nothing paid leaves it all owed", async () => {
  const { s, p1Lot, customer } = await withShopStock();
  const furaha = await customer("Furaha");
  const { saleId: paid } = await creditSale(s, s.agent, furaha, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 600 }], {
    paidNow: 600,
    paidNowMethod: "mobile_money",
  });
  expect(await getSale(s, paid)).toMatchObject({ amountPaid: 600, creditStatus: "settled" });
  const { saleId: unpaid } = await creditSale(s, s.agent, furaha, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 600 }]);
  expect(await getSale(s, unpaid)).toMatchObject({ amountPaid: 0, creditStatus: "open" });
  expect((await getCustomer(s, furaha))!.balance).toBe(600);
});

test("repayments go to the oldest sales first and can't exceed what's owed", async () => {
  const { s, p1Lot, p2Lot, customer } = await withShopStock();
  const sarah = await customer("Sarah K.");
  const { saleId: first } = await creditSale(s, s.agent, sarah, [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1000 }]);
  const { saleId: second } = await creditSale(s, s.agent, sarah, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }]);

  const owed = await s.as(s.agent).query(api.credit.owed, { businessUnitKey: "hair" });
  expect(owed).toMatchObject({ totalOwed: 1500, rows: [{ name: "Sarah K.", balance: 1500, openSales: 2 }] });

  const repay = (amount: number) =>
    s.as(s.agent).mutation(api.credit.recordRepayment, { customerId: sarah, amount, method: "mobile_money" });
  expect(await repay(1200)).toEqual({ sales: ["SALE-00001", "SALE-00002"] });
  expect(await getSale(s, first)).toMatchObject({ amountPaid: 1000, creditStatus: "settled" });
  expect(await getSale(s, second)).toMatchObject({ amountPaid: 200, creditStatus: "open" });
  expect((await getCustomer(s, sarah))!.balance).toBe(300);

  const err = await repay(400).then(() => null, (e) => e);
  expect(err.data).toMatchObject({ code: "OVERPAYMENT", owed: 300 });
  await expect(repay(0)).rejects.toThrow(/above 0/);

  await repay(300);
  expect(await getSale(s, second)).toMatchObject({ amountPaid: 500, creditStatus: "settled" });
  expect((await getCustomer(s, sarah))!.balance).toBe(0);
  expect((await s.as(s.agent).query(api.credit.owed, { businessUnitKey: "hair" })).rows).toEqual([]);
  await expect(repay(100)).rejects.toThrow(/owes nothing/);

  // Repayments are cash collected, not revenue: the rollups don't change.
  const incremental = await rollups(s);
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  expect(await rollups(s)).toEqual(incremental);
});

test("scope: an own_location seller only sees and collects their own location's credit", async () => {
  const { s, other, p1Lot, customer } = await withShopStock();
  const esther = await customer("Esther", s.sales);
  await creditSale(s, s.sales, esther, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: other });

  expect((await s.as(s.agent).query(api.credit.owed, { businessUnitKey: "hair" })).rows).toEqual([]);
  expect((await s.as(s.chief).query(api.credit.owed, { businessUnitKey: "hair" })).rows).toMatchObject([{ name: "Esther", balance: 500 }]);
  expect((await s.as(s.agent).query(api.credit.customer, { customerId: esther })).sales).toEqual([]);
  await expect(
    s.as(s.agent).mutation(api.credit.recordRepayment, { customerId: esther, amount: 100, method: "cash" }),
  ).rejects.toThrow(/owes nothing here/);
  await s.as(s.sales).mutation(api.credit.recordRepayment, { customerId: esther, amount: 100, method: "cash" });
  expect((await getCustomer(s, esther))!.balance).toBe(400);
  // Viewing credit needs sales.view.
  await expect(s.as(s.inventory).query(api.credit.owed, { businessUnitKey: "hair" })).rejects.toThrow(/sales\.view/);
});

test("a wrong payment is reversed through an approval, never by its requester", async () => {
  const { s, p1Lot, customer } = await withShopStock();
  const nadine = await customer("Nadine");
  const { saleId } = await creditSale(s, s.agent, nadine, [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }]);
  await s.as(s.agent).mutation(api.credit.recordRepayment, { customerId: nadine, amount: 1000, method: "cash" });
  expect(await getSale(s, saleId)).toMatchObject({ creditStatus: "settled" });
  const [payment] = await s.t.run((ctx) => ctx.db.query("salePayments").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());

  await expect(s.as(s.agent).mutation(api.credit.requestPaymentReversal, { paymentId: payment._id, reason: " " })).rejects.toThrow(
    /Say why/,
  );
  const approvalId = await s.as(s.agent).mutation(api.credit.requestPaymentReversal, {
    paymentId: payment._id,
    reason: "Counted twice",
  });
  await expect(s.as(s.agent).mutation(api.credit.requestPaymentReversal, { paymentId: payment._id, reason: "Again" })).rejects.toThrow(
    /already waiting/,
  );
  expect((await s.as(s.agent).query(api.credit.customer, { customerId: nadine })).payments).toMatchObject([
    { amount: 1000, reversed: false, reversalPending: true },
  ]);
  // The requester can't decide it.
  await expect(s.as(s.agent).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" })).rejects.toThrow();
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });

  expect(await getSale(s, saleId)).toMatchObject({ amountPaid: 0, creditStatus: "open" });
  expect((await getCustomer(s, nadine))!.balance).toBe(1000);
  const view = await s.as(s.agent).query(api.credit.customer, { customerId: nadine });
  expect(view.payments.map((p) => [p.kind, p.amount, p.reversed])).toEqual([
    ["reversal", -1000, false],
    ["repayment", 1000, true],
  ]);
  await expect(s.as(s.agent).mutation(api.credit.requestPaymentReversal, { paymentId: payment._id, reason: "Again" })).rejects.toThrow(
    /already reversed/,
  );

  // Payments are append-only.
  await expect(s.t.run((ctx) => appendOnlyGuardedDb(ctx).patch("salePayments", payment._id, { amount: 1 }))).rejects.toThrow();
  await expect(s.t.run((ctx) => appendOnlyGuardedDb(ctx).delete("salePayments", payment._id))).rejects.toThrow();
});

test("customers: one per name, found by name or phone", async () => {
  const { s, customer } = await withShopStock();
  const id = await customer("Chantal M.", s.agent, "0812 345 678");
  const err = await customer("  chantal   m. ").then(() => null, (e) => e);
  expect(err.data).toMatchObject({ code: "DUPLICATE_CUSTOMER", customerId: id });
  await expect(customer("  ")).rejects.toThrow(/name is required/);
  const search = (query: string) => s.as(s.agent).query(api.customers.search, { businessUnitKey: "hair", query });
  expect((await search("chantal")).map((c) => c.name)).toEqual(["Chantal M."]);
  expect((await search("0812")).map((c) => c._id)).toEqual([id]);
  expect(await search("")).toEqual([]);
  await expect(s.as(s.inventory).mutation(api.customers.create, { businessUnitKey: "hair", name: "X" })).rejects.toThrow(/sales\.create/);
});

test("backfill: earlier credit sales get a customer and count as unpaid, once", async () => {
  const { s } = await withShopStock();
  const legacy = (customerName: string, totalAmount: number) =>
    s.t.run((ctx) =>
      ctx.db.insert("sales", {
        businessUnitId: s.hairId,
        number: `SALE-L${totalAmount}`,
        locationId: s.shop,
        soldBy: s.agent,
        customerName,
        paymentMethod: "credit",
        currency: "USD",
        totalAmount,
        totalCost: 100,
        status: "completed",
        createdAt: Date.now(),
      }),
    );
  const a = await legacy("Mama Neema", 1200);
  await legacy("mama  NEEMA", 800);

  expect(await s.t.mutation(internal.credit.backfillLegacyCredit, {})).toEqual({ fixed: 2, more: false });
  const customers = await s.t.run((ctx) => ctx.db.query("customers").collect());
  expect(customers.map((c) => [c.name, c.balance])).toEqual([["Mama Neema", 2000]]);
  expect(await getSale(s, a)).toMatchObject({ customerId: customers[0]._id, amountPaid: 0, creditStatus: "open" });
  expect(await s.t.mutation(internal.credit.backfillLegacyCredit, {})).toEqual({ fixed: 0, more: false });
  expect((await getCustomer(s, customers[0]._id))!.balance).toBe(2000);
});
