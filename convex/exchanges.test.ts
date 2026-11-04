import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder, stockLevelOf } from "./lib/inventory";
import type { SaleExchangeChanges } from "./lib/exchanges";
import { returnedDiscountShare } from "./lib/sales";
import { businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * Goma Shop holds 6 of P1 ($2.00 cost) and 3 of P2 ($10.00 cost); Other
 * Shop holds 2 of P1. The agent sells at Goma Shop (own_location). Then a
 * cash sale there: 2 x P1 at $5.00, 1 x P2 at $15.00 ($25.00).
 */
async function withSale() {
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
  const { saleId } = await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [
      { inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 },
      { inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 },
    ],
  });
  const items = await itemsOf(s, saleId);
  const p1Item = items.find((i) => i.inventoryBatchId === p1Lot)!._id;
  const p2Item = items.find((i) => i.inventoryBatchId === p2Lot)!._id;
  return { s, other, p1Lot, p2Lot, shop, saleId, p1Item, p2Item };
}

const itemsOf = (s: Setup, saleId: Id<"sales">) =>
  s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
const onHand = async (s: Setup, lot: Id<"inventoryBatches">, holder: Id<"holders">) =>
  (await s.t.run((ctx) => stockLevelOf(ctx, lot, holder)))?.qtyOnHand ?? 0;
const exchange = (s: Setup, who: Id<"users">, saleId: Id<"sales">, changes: SaleExchangeChanges, reason?: string) =>
  s.as(who).mutation(api.sales.exchange, { saleId, changes, ...(reason !== undefined ? { reason } : {}) });
const decide = (s: Setup, who: Id<"users">, approvalId: Id<"approvals">, decision: "approve" | "reject" = "approve") =>
  s.as(who).mutation(api.approvals.decideApproval, { approvalId, decision });
const today = () => businessDayOf(Date.now());
const summary = (s: Setup) =>
  s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey: "hair", range: { from: today(), to: today() } });
const salesList = (s: Setup, who: Id<"users">) =>
  s.as(who).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: { numItems: 10, cursor: null } });

/** Rollups and productStock equal a full rebuild from raw data. */
async function expectRebuildMatches(s: Setup) {
  const derived = () =>
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
  const incremental = await derived();
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  await s.t.mutation(internal.inventory.rebuildProductStock, { businessUnitKey: "hair" });
  expect(await derived()).toEqual(incremental);
}

test("the customer pays more: recorded at once, stock back in and out, revenue up by the difference", async () => {
  const { s, saleId, p1Item, p1Lot, p2Lot, shop } = await withSale();
  // Brings 1 x P1 ($5.00) back, takes 1 x P2 at $15.00: pays $10.00.
  await expect(
    exchange(s, s.agent, saleId, { returned: [{ saleItemId: p1Item, qty: 1 }], given: [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 }] }),
  ).rejects.toThrow(/how the customer pays/);
  const result = await exchange(s, s.agent, saleId, {
    returned: [{ saleItemId: p1Item, qty: 1 }],
    given: [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 }],
    settlementMethod: "cash",
  });
  expect(result).toMatchObject({ status: "completed", number: "EXCH-00001", differenceAmount: 1000 });

  expect(await onHand(s, p1Lot, shop)).toBe(5); // 6 - 2 sold + 1 back
  expect(await onHand(s, p2Lot, shop)).toBe(1); // 3 - 1 sold - 1 given
  // The sale itself is untouched.
  expect((await itemsOf(s, saleId)).map((i) => i.qty)).toEqual([2, 1]);
  // Revenue: $25.00 + $10.00; cost: $14.00 - $2.00 + $10.00.
  expect(await summary(s)).toMatchObject({ sales: 3500, cost: 2200, margin: 1300 });

  const exchangeRow = await s.t.run((ctx) => ctx.db.query("saleExchanges").first());
  expect(exchangeRow).toMatchObject({ returnedAmount: 500, givenTotal: 1500, differenceAmount: 1000, settlementMethod: "cash", recordedBy: s.agent });
  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find((a) => a.entityTable === "saleExchanges" && a.action === "create"),
  );
  expect(audit!.after).toMatchObject({ sale: "SALE-00001", returned: [{ product: "P1", qty: 1 }], given: [{ product: "P2", qty: 1 }] });

  const row = (await salesList(s, s.agent)).page[0];
  expect(row.exchanges).toHaveLength(1);
  expect(row.exchangeable).toBe(true);

  // Once exchanged, the sale can't be corrected.
  const items = await itemsOf(s, saleId);
  await expect(
    s.as(s.agent).mutation(api.sales.requestEdit, {
      saleId,
      reason: "Wrong price",
      changes: { lines: items.map((i) => ({ saleItemId: i._id, qty: i.qty, unitPrice: i.unitPrice + 100 })) },
    }),
  ).rejects.toThrow(/exchanged/);
  await expectRebuildMatches(s);
});

test("a refund waits for approval; nothing moves until the Super Admin approves", async () => {
  const { s, saleId, p1Item, p2Item, p1Lot, p2Lot, shop } = await withSale();
  // Brings P2 ($15.00) back, takes 1 x P1 at $5.00: $10.00 back.
  const changes: SaleExchangeChanges = {
    returned: [{ saleItemId: p2Item, qty: 1 }],
    given: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }],
    settlementMethod: "mobile_money",
  };
  await expect(exchange(s, s.agent, saleId, changes)).rejects.toThrow(/Say why/);
  const result = await exchange(s, s.agent, saleId, changes, "Wrong colour");
  expect(result).toMatchObject({ status: "pending", differenceAmount: -1000 });
  if (result.status !== "pending") throw new Error("expected pending");

  expect(await onHand(s, p2Lot, shop)).toBe(2);
  expect(await summary(s)).toMatchObject({ sales: 2500 });
  expect((await salesList(s, s.agent)).page[0]).toMatchObject({ pendingExchange: true, exchangeable: false });
  // No other exchange or correction meanwhile.
  await expect(
    exchange(s, s.agent, saleId, { returned: [{ saleItemId: p1Item, qty: 1 }], given: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }] }),
  ).rejects.toThrow(/waiting for approval/);

  const approval = await s.t.run((ctx) => ctx.db.get("approvals", result.approvalId));
  expect(approval).toMatchObject({ type: "sale_exchange", requiredPermission: "sales.edit.approve", locationId: s.shop });
  expect(approval!.payload.after).toMatchObject({ differenceAmount: -1000, currency: "USD" });

  await expect(decide(s, s.agent, result.approvalId)).rejects.toThrow();
  await expect(decide(s, s.chief, result.approvalId)).rejects.toThrow();
  await decide(s, s.superAdmin, result.approvalId);

  expect(await onHand(s, p2Lot, shop)).toBe(3);
  expect(await onHand(s, p1Lot, shop)).toBe(3);
  expect(await summary(s)).toMatchObject({ sales: 1500, cost: 600 });
  const exchangeRow = await s.t.run((ctx) => ctx.db.query("saleExchanges").first());
  expect(exchangeRow).toMatchObject({ recordedBy: s.agent, approvedBy: s.superAdmin, approvalId: result.approvalId, reason: "Wrong colour" });
  await expectRebuildMatches(s);
});

test("a rejected refund changes nothing; stock gone meanwhile keeps it pending", async () => {
  const { s, saleId, p2Item, p1Lot, shop } = await withSale();
  const changes: SaleExchangeChanges = {
    returned: [{ saleItemId: p2Item, qty: 1 }],
    given: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }],
    settlementMethod: "cash",
  };
  const first = await exchange(s, s.agent, saleId, changes, "Changed mind");
  if (first.status !== "pending") throw new Error("expected pending");
  await decide(s, s.superAdmin, first.approvalId, "reject");
  expect(await s.t.run((ctx) => ctx.db.query("saleExchanges").first())).toBeNull();
  expect(await onHand(s, p1Lot, shop)).toBe(4);

  const second = await exchange(s, s.agent, saleId, changes, "Changed mind");
  if (second.status !== "pending") throw new Error("expected pending");
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 3, unitPrice: 500 }],
  });
  await expect(decide(s, s.superAdmin, second.approvalId)).rejects.toThrow(/Only 1 of P1/);
  expect((await s.t.run((ctx) => ctx.db.get("approvals", second.approvalId)))!.status).toBe("pending");
});

test("refusals: more than sold, other shop, credit sale, too old", async () => {
  const { s, saleId, p1Item, p1Lot, other, p2Lot } = await withSale();
  const swap = (qty: number): SaleExchangeChanges => ({
    returned: [{ saleItemId: p1Item, qty }],
    given: [{ inventoryBatchId: p1Lot, qty, unitPrice: 500 }],
  });
  await expect(exchange(s, s.agent, saleId, swap(3))).rejects.toThrow(/Only 2 of P1 can still be brought back/);
  await exchange(s, s.agent, saleId, swap(1));
  await exchange(s, s.agent, saleId, swap(1));
  await expect(exchange(s, s.agent, saleId, swap(1))).rejects.toThrow(/Only 0 of P1/);
  await expect(exchange(s, s.agent, saleId, { returned: [], given: swap(1).given })).rejects.toThrow(/brings back/);

  // A sale at Other Shop: the agent (Goma Shop) can't exchange it.
  const { saleId: otherSale } = await s.as(s.sales).mutation(api.sales.create, {
    businessUnitKey: "hair",
    locationId: other,
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }],
  });
  const otherItem = (await itemsOf(s, otherSale))[0]._id;
  const otherSwap = { returned: [{ saleItemId: otherItem, qty: 1 }], given: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }] };
  await expect(exchange(s, s.agent, otherSale, otherSwap)).rejects.toThrow();
  await expect(s.as(s.agent).query(api.sales.exchangeOptions, { saleId: otherSale })).rejects.toThrow();
  // Given products come from the sale's own location.
  await expect(
    exchange(s, s.sales, otherSale, { ...otherSwap, given: [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 500 }], settlementMethod: "cash" }, "x"),
  ).rejects.toThrow(/Only 0 of P2/);

  // A credit sale.
  const customerId = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Amani" });
  const { saleId: creditSale } = await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "credit",
    customerId,
    lines: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }],
  });
  const creditItem = (await itemsOf(s, creditSale))[0]._id;
  await expect(
    exchange(s, s.agent, creditSale, { returned: [{ saleItemId: creditItem, qty: 1 }], given: swap(1).given }),
  ).rejects.toThrow(/credit sale/);

  // More than 30 days ago.
  await s.t.run((ctx) => ctx.db.patch("sales", saleId, { createdAt: Date.now() - 31 * 86_400_000 }));
  const options = await s.as(s.agent).query(api.sales.exchangeOptions, { saleId });
  expect(options!.refusal).toMatch(/30 days/);
  await expect(exchange(s, s.agent, saleId, swap(1))).rejects.toThrow(/30 days/);
});

test("a whole-sale discount: returned units carry their share, adding up to the line's share", async () => {
  expect(returnedDiscountShare({ qty: 3, saleDiscountShare: 100 }, 0, 1)).toBe(33);
  expect(returnedDiscountShare({ qty: 3, saleDiscountShare: 100 }, 1, 1)).toBe(34);
  expect(returnedDiscountShare({ qty: 3, saleDiscountShare: 100 }, 2, 1)).toBe(33);

  const { s, p1Lot, p2Lot } = await withSale();
  const { saleId } = await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    agreedTotal: 900,
    saleDiscountReason: "Loyal customer",
    lines: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }],
  });
  const item = (await itemsOf(s, saleId))[0]._id;
  const options = await s.as(s.agent).query(api.sales.exchangeOptions, { saleId });
  expect(options!.lines[0]).toMatchObject({ returnable: 2, saleDiscountShare: 100 });
  // 1 x P1 was paid $4.50; P2 at $15.00: pays $10.50.
  const result = await exchange(s, s.agent, saleId, {
    returned: [{ saleItemId: item, qty: 1 }],
    given: [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 }],
    settlementMethod: "mobile_money",
  });
  expect(result.differenceAmount).toBe(1050);
  // Even swap of the last unit (paid $4.50) for 1 x P1 at $4.50.
  await exchange(s, s.agent, saleId, {
    returned: [{ saleItemId: item, qty: 1 }],
    given: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 450 }],
  });
  const returned = await s.t.run(async (ctx) =>
    (await ctx.db.query("saleExchangeItems").collect()).filter((i) => i.direction === "returned"),
  );
  expect(returned.reduce((sum, i) => sum + (i.saleDiscountShare ?? 0), 0)).toBe(100);
  await expectRebuildMatches(s);
});
