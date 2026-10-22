import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder, stockLevelOf } from "./lib/inventory";
import type { SaleEditChanges } from "./lib/saleEdits";
import { addBusinessDays, businessDayOf } from "./lib/time";
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
  const shop = await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    const holder = (refId: Id<"locations">) => getOrCreateHolder(ctx, s.hairId, { type: "location", refId });
    const move = async (lot: Id<"inventoryBatches">, to: Id<"locations">, qty: number) =>
      applyMovement(ctx, {
        type: "distribute",
        inventoryBatchId: lot,
        fromHolderId: business,
        toHolderId: await holder(to),
        qty,
        refTable: "test",
        refId: "setup",
        actorId: s.chief,
      });
    await move(p1Lot, s.shop, 6);
    await move(p2Lot, s.shop, 3);
    await move(p1Lot, other, 2);
    return await holder(s.shop);
  });
  return { s, other, p1Lot, p2Lot, shop };
}

/** A cash sale at Goma Shop by the agent: 2 x P1 at $5.00, 1 x P2 at $15.00. */
async function withSale() {
  const env = await withShopStock();
  const { saleId } = await env.s.as(env.s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [
      { inventoryBatchId: env.p1Lot, qty: 2, unitPrice: 500 },
      { inventoryBatchId: env.p2Lot, qty: 1, unitPrice: 1500 },
    ],
  });
  return { ...env, saleId };
}

const getSale = (s: Setup, id: Id<"sales">) => s.t.run((ctx) => ctx.db.get("sales", id));
const itemsOf = (s: Setup, saleId: Id<"sales">) =>
  s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
const onHand = async (s: Setup, lot: Id<"inventoryBatches">, holder: Id<"holders">) =>
  (await s.t.run((ctx) => stockLevelOf(ctx, lot, holder)))?.qtyOnHand ?? 0;

/** Changes that keep everything as it is, for the tests to adjust. */
async function unchanged(s: Setup, saleId: Id<"sales">): Promise<SaleEditChanges> {
  const items = await itemsOf(s, saleId);
  return { lines: items.map((i) => ({ saleItemId: i._id, qty: i.qty, unitPrice: i.unitPrice })) };
}

const requestEdit = (s: Setup, who: Id<"users">, saleId: Id<"sales">, changes: SaleEditChanges, reason = "Wrong price") =>
  s.as(who).mutation(api.sales.requestEdit, { saleId, reason, changes });
const decide = (s: Setup, who: Id<"users">, approvalId: Id<"approvals">, decision: "approve" | "reject" = "approve") =>
  s.as(who).mutation(api.approvals.decideApproval, { approvalId, decision });

/** Rollup and stock summary rows without ids, comparable before and after a rebuild. */
const derived = (s: Setup) =>
  s.t.run(async (ctx) => {
    const strip = <T extends { _id: unknown; _creationTime: unknown }>({ _id, _creationTime, ...rest }: T) => {
      void _id;
      void _creationTime;
      return JSON.stringify(rest);
    };
    return {
      finance: (await ctx.db.query("dailyFinance").collect()).map(strip).sort(),
      stats: (await ctx.db.query("dailyStats").collect()).map(strip).sort(),
      productStock: (await ctx.db.query("productStock").collect()).map(strip).sort(),
    };
  });
async function expectRebuildMatches(s: Setup) {
  const incremental = await derived(s);
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  await s.t.mutation(internal.inventory.rebuildProductStock, { businessUnitKey: "hair" });
  expect(await derived(s)).toEqual(incremental);
}

test("a price correction: requested with a reason, applied only when the Super Admin approves", async () => {
  const { s, saleId } = await withSale();
  const changes = await unchanged(s, saleId);
  changes.lines[0].unitPrice = 400;

  await expect(requestEdit(s, s.agent, saleId, changes, "  ")).rejects.toThrow(/Say why/);
  await expect(requestEdit(s, s.agent, saleId, await unchanged(s, saleId))).rejects.toThrow(/Nothing was changed/);
  const approvalId = await requestEdit(s, s.agent, saleId, changes);
  await expect(requestEdit(s, s.agent, saleId, changes)).rejects.toThrow(/already pending/);

  // Nothing changes yet; the list shows the correction is waiting.
  expect(await getSale(s, saleId)).toMatchObject({ totalAmount: 2500 });
  const list = await s.as(s.agent).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: { numItems: 10, cursor: null } });
  expect(list.page[0].pendingEdit).toBe(true);
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", approvalId));
  expect(approval).toMatchObject({ type: "sale_edit", requiredPermission: "sales.edit.approve", locationId: s.shop });
  expect(approval!.payload.before).toMatchObject({ totalAmount: 2500, items: [{ product: "P1", qty: 2, unitPrice: 500 }, {}] });
  expect(approval!.payload.after).toMatchObject({ totalAmount: 2300, items: [{ product: "P1", qty: 2, unitPrice: 400 }, {}] });

  // The requester, the Chief Admin and the Chief Sales Admin can't approve it.
  await expect(decide(s, s.agent, approvalId)).rejects.toThrow();
  await expect(decide(s, s.chief, approvalId)).rejects.toThrow();
  await expect(decide(s, s.sales, approvalId)).rejects.toThrow();
  await decide(s, s.superAdmin, approvalId);

  expect(await getSale(s, saleId)).toMatchObject({ totalAmount: 2300, linesTotal: 2300, totalCost: 1400 });
  expect((await itemsOf(s, saleId)).map((i) => [i.qty, i.unitPrice])).toEqual([[2, 400], [1, 1500]]);
  const today = businessDayOf(Date.now());
  const summary = await s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey: "hair", range: { from: today, to: today } });
  expect(summary).toMatchObject({ sales: 2300, cost: 1400, margin: 900 });
  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "sales" && a.entityId === saleId && a.action === "update"),
  );
  expect(audit.at(-1)).toMatchObject({ actorId: s.superAdmin, reason: "Wrong price", after: { totalAmount: 2300, approvalId } });
  await expectRebuildMatches(s);
});

test("a rejected correction changes nothing", async () => {
  const { s, saleId } = await withSale();
  const changes = await unchanged(s, saleId);
  changes.lines[1].qty = 0;
  const approvalId = await requestEdit(s, s.agent, saleId, changes, "Not sold");
  const before = { sale: await getSale(s, saleId), items: await itemsOf(s, saleId), derived: await derived(s) };
  await decide(s, s.superAdmin, approvalId, "reject");
  expect({ sale: await getSale(s, saleId), items: await itemsOf(s, saleId), derived: await derived(s) }).toEqual(before);
});

test("quantities: lowering returns stock to the shop, raising takes it, a line at 0 is removed", async () => {
  const { s, saleId, p1Lot, p2Lot, shop } = await withSale();
  expect([await onHand(s, p1Lot, shop), await onHand(s, p2Lot, shop)]).toEqual([4, 2]);

  // More than the shop holds is refused when asked; at least one line stays.
  const tooMany = await unchanged(s, saleId);
  tooMany.lines[0].qty = 7;
  await expect(requestEdit(s, s.agent, saleId, tooMany)).rejects.toThrow(/Only 4 more of P1/);
  const none = await unchanged(s, saleId);
  none.lines.forEach((l) => (l.qty = 0));
  await expect(requestEdit(s, s.agent, saleId, none)).rejects.toThrow(/at least one product/);

  const changes = await unchanged(s, saleId);
  changes.lines[0].qty = 3;
  changes.lines[1].qty = 0;
  const approvalId = await requestEdit(s, s.agent, saleId, changes, "One more P1, no P2");
  await decide(s, s.superAdmin, approvalId);

  expect([await onHand(s, p1Lot, shop), await onHand(s, p2Lot, shop)]).toEqual([3, 3]);
  expect((await itemsOf(s, saleId)).map((i) => [i.inventoryBatchId, i.qty])).toEqual([[p1Lot, 3]]);
  expect(await getSale(s, saleId)).toMatchObject({ totalAmount: 1500, totalCost: 600 });
  const movements = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_refTable_and_refId", (q) => q.eq("refTable", "sales").eq("refId", saleId)).collect(),
  );
  expect(movements.slice(2).map((m) => [m.type, m.qty])).toEqual([["sale", 1], ["return", 1]]);
  const p2Stock = await s.t.run(async (ctx) =>
    (await ctx.db.query("productStock").collect()).find((r) => r.productId === s.p2),
  );
  expect(p2Stock).toMatchObject({ sold: 0, onHand: 3 });
  await expectRebuildMatches(s);
});

test("stock sold elsewhere meanwhile: the approval fails and stays pending", async () => {
  const { s, saleId, p1Lot } = await withSale();
  const changes = await unchanged(s, saleId);
  changes.lines[0].qty = 5;
  const approvalId = await requestEdit(s, s.agent, saleId, changes, "Sold 5");
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }],
  });
  await expect(decide(s, s.superAdmin, approvalId)).rejects.toThrow(/Only 2 more of P1/);
  expect((await s.t.run((ctx) => ctx.db.get("approvals", approvalId)))!.status).toBe("pending");
  expect((await itemsOf(s, saleId))[0].qty).toBe(2);
});

test("details: payment method, customer name, date, and a lower total with its reason", async () => {
  const { s, saleId } = await withSale();
  const changes = await unchanged(s, saleId);
  await expect(requestEdit(s, s.agent, saleId, { ...changes, paymentMethod: "credit" })).rejects.toThrow(/to or from credit/);
  await expect(requestEdit(s, s.agent, saleId, { ...changes, agreedTotal: 2000 })).rejects.toThrow(/lower than the lines/);
  const tooOld = addBusinessDays(businessDayOf(Date.now()), -8);
  await expect(requestEdit(s, s.agent, saleId, { ...changes, soldOn: tooOld })).rejects.toThrow(/last 7 days/);
  // A price other than suggested needs a reason (P1 suggested at $5.00 at sale time).
  await s.t.run(async (ctx) => {
    const [first] = await ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect();
    await ctx.db.patch("saleItems", first._id, { suggestedPriceSnapshot: 500 });
  });
  const priced = await unchanged(s, saleId);
  priced.lines[0].unitPrice = 450;
  await expect(requestEdit(s, s.agent, saleId, priced)).rejects.toThrow(/give a reason/);

  const yesterday = addBusinessDays(businessDayOf(Date.now()), -1);
  const approvalId = await requestEdit(s, s.agent, saleId, {
    ...changes,
    paymentMethod: "mobile_money",
    customerName: " Mama Neema ",
    soldOn: yesterday,
    agreedTotal: 2000,
    saleDiscountReason: "Bought three",
  });
  await decide(s, s.superAdmin, approvalId);
  const sale = await getSale(s, saleId);
  expect(sale).toMatchObject({
    paymentMethod: "mobile_money",
    customerName: "Mama Neema",
    totalAmount: 2000,
    linesTotal: 2500,
    saleDiscountReason: "Bought three",
  });
  expect(businessDayOf(sale!.createdAt)).toBe(yesterday);
  expect((await itemsOf(s, saleId)).map((i) => i.saleDiscountShare)).toEqual([200, 300]);
  const range = { from: yesterday, to: businessDayOf(Date.now()) };
  const summary = await s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey: "hair", range });
  expect(summary).toMatchObject({ sales: 2000 });
  await expectRebuildMatches(s);
});

test("a credit sale: the balance follows the new total, never below what was paid", async () => {
  const { s, p1Lot } = await withShopStock();
  const customerId = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Nadine" });
  const { saleId } = await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "credit",
    customerId,
    paidNow: 600,
    paidNowMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }],
  });
  const changes = await unchanged(s, saleId);
  changes.lines[0].unitPrice = 250;
  await expect(requestEdit(s, s.agent, saleId, changes)).rejects.toThrow(/already paid/);
  await expect(requestEdit(s, s.agent, saleId, { ...(await unchanged(s, saleId)), customerName: "Other" })).rejects.toThrow(
    /customer can't be changed/,
  );

  changes.lines[0].unitPrice = 300;
  await decide(s, s.superAdmin, await requestEdit(s, s.agent, saleId, changes));
  expect(await getSale(s, saleId)).toMatchObject({ totalAmount: 600, amountPaid: 600, creditStatus: "settled" });
  expect((await s.t.run((ctx) => ctx.db.get("customers", customerId)))!.balance).toBe(0);
  await expectRebuildMatches(s);
});

test("requests are scoped like sales; the Super Admin may approve their own, flagged", async () => {
  const { s, other, p1Lot } = await withShopStock();
  const { saleId } = await s.as(s.superAdmin).mutation(api.sales.create, {
    businessUnitKey: "hair",
    locationId: other,
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }],
  });
  const changes = await unchanged(s, saleId);
  changes.lines[0].unitPrice = 450;
  // The agent works at Goma Shop, not Other Shop.
  await expect(requestEdit(s, s.agent, saleId, changes)).rejects.toThrow();
  await expect(s.as(s.agent).query(api.sales.editOptions, { saleId })).rejects.toThrow();
  // Everyone who sees sales may request (the Manager Admin, here).
  const options = await s.as(s.manager).query(api.sales.editOptions, { saleId });
  expect(options!.lines).toMatchObject([{ productName: "P1", qty: 1, unitPrice: 500, available: 1 }]);

  const approvalId = await requestEdit(s, s.superAdmin, saleId, changes);
  await decide(s, s.superAdmin, approvalId);
  expect((await itemsOf(s, saleId))[0].unitPrice).toBe(450);
  const decision = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find((a) => a.entityTable === "approvals" && a.entityId === approvalId && a.action === "approve"),
  );
  expect(decision!.after).toMatchObject({ selfApproved: true });
});
