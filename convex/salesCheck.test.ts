import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { weekdayOf } from "./lib/salesDays";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { getBusinessUnitId, insertLocation } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * Goma Shop holds 6 of P1 and 3 of P2, Other Shop 2 of P1. The Super Admin
 * sold P1 + P2 at Goma Shop two days ago, and P1 at Other Shop today.
 */
async function setup() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const other = await insertLocation(s.t, { name: "Other Shop" });
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const p1Lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!;
  const p2Lot = lots.find((l) => l.sourceStockBatchItemId === b.i2._id)!;
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
    await move(p1Lot._id, s.shop, 6);
    await move(p2Lot._id, s.shop, 3);
    await move(p1Lot._id, other, 2);
  });
  const today = businessDayOf(Date.now());
  const day = (n: number) => addBusinessDays(today, n);
  const { saleId } = await s.as(s.superAdmin).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    locationId: s.shop,
    soldOn: day(-2),
    lines: [
      { inventoryBatchId: p1Lot._id, qty: 2, unitPrice: 500, discountReason: "test" },
      { inventoryBatchId: p2Lot._id, qty: 1, unitPrice: 1500, discountReason: "test" },
    ],
  });
  await s.as(s.superAdmin).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    locationId: other,
    lines: [{ inventoryBatchId: p1Lot._id, qty: 1, unitPrice: 500, discountReason: "test" }],
  });
  const P1 = p1Lot.productId;
  const P2 = p2Lot.productId;
  return { s, other, P1, P2, saleId, today, day };
}

const check = (
  s: Setup,
  who: Id<"users">,
  items: Array<{ productId: Id<"products">; qty?: number }>,
  extra: { from?: string; to?: string; locationId?: Id<"locations"> } = {},
) => {
  const today = businessDayOf(Date.now());
  return s.as(who).query(api.salesCheck.find, {
    businessUnitKey: "hair",
    from: extra.from ?? addBusinessDays(today, -29),
    to: extra.to ?? today,
    items,
    ...(extra.locationId ? { locationId: extra.locationId } : {}),
  });
};

test("finds the shop-day that sold every listed product, with qty differences", async () => {
  const { s, P1, P2, day } = await setup();
  const result = await check(s, s.superAdmin, [{ productId: P1, qty: 3 }, { productId: P2 }]);
  expect(result.kind).toBe("full");
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    day: day(-2),
    locationName: "Goma Shop",
    matched: 2,
    missing: [],
    extras: [],
    // Shops are closed on Sundays by default: true when the test runs on a Tuesday.
    closed: weekdayOf(day(-2)) === 0 ? "weekday" : null,
  });
  expect(result.results[0].found).toEqual([
    { productId: P1, units: 2, qtyDiff: -1 },
    { productId: P2, units: 1, qtyDiff: null },
  ]);
  expect(result.products.find((p) => p.productId === P1)).toMatchObject({ productName: "P1" });

  // Only P1: both shop-days match, the one with no extra product first.
  const p1Only = await check(s, s.superAdmin, [{ productId: P1 }]);
  expect(p1Only.results.map((r) => [r.locationName, r.extras.length])).toEqual([
    ["Other Shop", 0],
    ["Goma Shop", 1],
  ]);
});

test("no full match: best partial with the missing product", async () => {
  const { s, P1, P2, other } = await setup();
  const result = await check(s, s.superAdmin, [{ productId: P1 }, { productId: P2 }], { locationId: other });
  expect(result.kind).toBe("partial");
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ locationName: "Other Shop", matched: 1, missing: [P2] });
});

test("scope: sales.view needed; own_location viewers only see their own shop", async () => {
  const { s, P1, other } = await setup();
  // Chief Inventory Admin has no sales.view.
  await expect(check(s, s.inventory, [{ productId: P1 }])).rejects.toThrow();
  // The agent works at Goma Shop: Other Shop is never searched, even when asked for.
  const mine = await check(s, s.agent, [{ productId: P1 }], { locationId: other });
  expect(mine.results.map((r) => r.locationName)).toEqual(["Goma Shop"]);
});

test("refuses another service's product, wrong quantities, empty lists and long ranges", async () => {
  const { s, P1, today, day } = await setup();
  const modeId = await getBusinessUnitId(s.t, "fashion");
  const shirt = await s.t.run((ctx) =>
    ctx.db.insert("products", {
      businessUnitId: modeId,
      name: "Shirt",
      sku: "MODE-1",
      category: "tops",
      unit: "piece",
      status: "active",
      createdBy: s.chief,
      searchText: "shirt",
    }),
  );
  await expect(check(s, s.superAdmin, [{ productId: shirt }])).rejects.toThrow(/Product not found/);
  await expect(check(s, s.superAdmin, [{ productId: P1, qty: 0 }])).rejects.toThrow(/whole numbers/);
  await expect(check(s, s.superAdmin, [])).rejects.toThrow(/at least one/);
  await expect(check(s, s.superAdmin, [{ productId: P1 }], { from: day(-100), to: today })).rejects.toThrow(/at most/);
  await expect(check(s, s.superAdmin, [{ productId: P1 }], { from: today, to: day(1) })).rejects.toThrow(/future/);
});

test("an approved date correction moves the match to the new day", async () => {
  const { s, P1, P2, saleId, day } = await setup();
  const items = await s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
  const approvalId = await s.as(s.sales).mutation(api.sales.requestEdit, {
    saleId,
    reason: "Wrong day",
    changes: {
      lines: items.map((i) => ({ saleItemId: i._id, qty: i.qty, unitPrice: i.unitPrice, discountReason: i.discountReason })),
      soldOn: day(-4),
    },
  });
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  const result = await check(s, s.superAdmin, [{ productId: P1 }, { productId: P2 }]);
  expect(result.results.map((r) => r.day)).toEqual([day(-4)]);
});

test("flags a matching day the shop is closed on, and counts days marked closed", async () => {
  const { s, P1, P2, day } = await setup();
  const weekday = weekdayOf(day(-2));
  await s.t.run(async (ctx) => {
    await ctx.db.patch("locations", s.shop, { openDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday) });
    await ctx.db.insert("closedSalesDays", {
      businessUnitId: s.hairId,
      locationId: s.shop,
      day: day(-5),
      active: true,
      markedBy: s.superAdmin,
      markedAt: Date.now(),
    });
  });
  const result = await check(s, s.superAdmin, [{ productId: P1 }, { productId: P2 }]);
  expect(result.results[0]).toMatchObject({ day: day(-2), closed: "weekday" });
  expect(result.markedClosedDays).toBe(1);
});
