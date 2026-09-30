import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder, stockLevelOf } from "./lib/inventory";
import { lineMargin, saleLineProblems, saleTimestamp } from "./lib/sales";
import { addBusinessDays, businessDayOf, businessDayStartUtc } from "./lib/time";
import { PAGE, arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation, insertUserWithRole } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * Received mixed batch, then moved to Goma Shop: 6 of P1 ($2.00 cost) and
 * 3 of P2 ($10.00 cost). A second shop holds 2 of P1. The agent works at
 * Goma Shop (own_location).
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
  const holders = await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    const shop = await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop });
    const otherShop = await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: other });
    const move = (inventoryBatchId: Id<"inventoryBatches">, to: Id<"holders">, qty: number) =>
      applyMovement(ctx, {
        type: "distribute",
        inventoryBatchId,
        fromHolderId: business,
        toHolderId: to,
        qty,
        refTable: "test",
        refId: "setup",
        actorId: s.chief,
      });
    await move(p1Lot, shop, 6);
    await move(p2Lot, shop, 3);
    await move(p1Lot, otherShop, 2);
    return { shop, otherShop };
  });
  return { s, other, p1Lot, p2Lot, ...holders };
}

const onHand = async (s: Setup, lot: Id<"inventoryBatches">, holder: Id<"holders">) =>
  (await s.t.run((ctx) => stockLevelOf(ctx, lot, holder)))?.qtyOnHand ?? 0;

type Line = { inventoryBatchId: Id<"inventoryBatches">; qty: number; unitPrice: number; discountReason?: string };
const sell = (
  s: Setup,
  who: Id<"users">,
  lines: Line[],
  extra: Partial<{
    locationId: Id<"locations">;
    paymentMethod: "cash" | "mobile_money" | "credit";
    customerName: string;
    soldOn: string;
  }> = {},
) =>
  s.as(who).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: extra.paymentMethod ?? "cash",
    ...(extra.locationId ? { locationId: extra.locationId } : {}),
    ...(extra.customerName ? { customerName: extra.customerName } : {}),
    ...(extra.soldOn ? { soldOn: extra.soldOn } : {}),
    lines,
  });

test("an agent sells at their own location: stock goes down, cost is snapshotted", async () => {
  const { s, p1Lot, p2Lot, shop } = await withShopStock();
  const options = await s.as(s.agent).query(api.sales.options, { businessUnitKey: "hair" });
  expect(options).toMatchObject({ locationLocked: true, locationId: s.shop, locations: [{ name: "Goma Shop" }] });
  expect(options.lots.map((l) => [l.productName, l.onHand, l.unitCost, l.batchNumber])).toEqual([
    ["P1", 6, 200, "BATCH-00001"],
    ["P2", 3, 1000, "BATCH-00001"],
  ]);

  const { saleId, number } = await sell(s, s.agent, [
    { inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 },
    { inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 },
  ]);
  expect(number).toBe("SALE-00001");
  expect(await onHand(s, p1Lot, shop)).toBe(4);
  expect(await onHand(s, p2Lot, shop)).toBe(2);

  const sale = await s.t.run((ctx) => ctx.db.get("sales", saleId));
  expect(sale).toMatchObject({
    locationId: s.shop,
    soldBy: s.agent,
    paymentMethod: "cash",
    currency: "USD",
    totalAmount: 2500,
    totalCost: 1400,
    status: "completed",
  });
  const items = await s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
  expect(items.map((i) => [i.qty, i.unitPrice, i.unitCostSnapshot])).toEqual([[2, 500, 200], [1, 1500, 1000]]);
  expect(items.map(lineMargin)).toEqual([600, 500]);

  const movements = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_refTable_and_refId", (q) => q.eq("refTable", "sales").eq("refId", saleId)).collect(),
  );
  expect(movements.map((m) => [m.type, m.qty, m.fromHolderId, m.toHolderId ?? null])).toEqual([
    ["sale", 2, shop, null],
    ["sale", 1, shop, null],
  ]);
  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find((a) => a.entityTable === "sales" && a.entityId === saleId),
  );
  expect(audit!.after).toMatchObject({ number: "SALE-00001", location: "Goma Shop", totalAmount: 2500, currency: "USD" });
});

test("agents are locked to their own location; chiefs and the Super Admin sell anywhere", async () => {
  const { s, other, p1Lot, otherShop } = await withShopStock();
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: other }),
  ).rejects.toThrow(/only sell at your own location/);
  // The agent's options never offer another location.
  const agentOptions = await s.as(s.agent).query(api.sales.options, { businessUnitKey: "hair", locationId: other });
  expect(agentOptions.locationId).toBe(s.shop);

  // Chief Sales Admin (all_locations) sells at the other shop.
  const salesOptions = await s.as(s.sales).query(api.sales.options, { businessUnitKey: "hair", locationId: other });
  expect(salesOptions.locationLocked).toBe(false);
  expect(salesOptions.locations.map((l) => l.name)).toEqual(["Goma Shop", "Other Shop"]);
  await sell(s, s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: other });
  // So does the Super Admin.
  await sell(s, s.superAdmin, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: other });
  expect(await onHand(s, p1Lot, otherShop)).toBe(0);

  // They must say where; an inactive location is refused.
  await expect(sell(s, s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }])).rejects.toThrow(/Choose the location/);
  const closed = await insertLocation(s.t, { name: "Closed", active: false });
  await expect(
    sell(s, s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: closed }),
  ).rejects.toThrow(/active location/);
  // No sales.create, no sale.
  await expect(sell(s, s.inventory, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: s.shop })).rejects.toThrow(
    /sales\.create/,
  );
});

test("stock never goes negative: overselling fails and changes nothing; the last unit sells once", async () => {
  const { s, p1Lot, p2Lot, shop } = await withShopStock();
  const count = async () => (await s.t.run((ctx) => ctx.db.query("sales").collect())).length;

  // 7 > 6 on hand: nothing is written, not even the first (valid) line.
  const err = await sell(s, s.agent, [
    { inventoryBatchId: p2Lot, qty: 1, unitPrice: 1500 },
    { inventoryBatchId: p1Lot, qty: 7, unitPrice: 500 },
  ]).then(() => null, (e) => e);
  expect(err.data).toMatchObject({ code: "INSUFFICIENT_STOCK", inventoryBatchId: p1Lot, onHand: 6 });
  expect(await count()).toBe(0);
  expect(await s.t.run((ctx) => ctx.db.query("saleItems").collect())).toEqual([]);
  expect(await onHand(s, p1Lot, shop)).toBe(6);
  expect(await onHand(s, p2Lot, shop)).toBe(3);

  // Exactly what's left sells; after that, the last unit can't be sold again.
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 6, unitPrice: 500 }]);
  await expect(sell(s, s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { locationId: s.shop })).rejects.toThrow(
    /Only 0 left of P1 at Goma Shop/,
  );
  expect(await onHand(s, p1Lot, shop)).toBe(0);
  expect(await count()).toBe(1);

  // A lot that isn't at the location (the new closure stayed with the business).
  const closure = (await s.t.run((ctx) => ctx.db.query("inventoryBatches").collect())).find((l) => l.receivedQty === 3 && l._id !== p2Lot)!;
  await expect(sell(s, s.agent, [{ inventoryBatchId: closure._id, qty: 1, unitPrice: 500 }])).rejects.toThrow(/Only 0 left/);
});

test("two sellers racing for the last units: one wins, the other fails", async () => {
  const { s, p2Lot, shop } = await withShopStock();
  const results = await Promise.allSettled([
    sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 3, unitPrice: 1500 }]),
    sell(s, s.sales, [{ inventoryBatchId: p2Lot, qty: 2, unitPrice: 1500 }], { locationId: s.shop }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const remaining = await onHand(s, p2Lot, shop);
  expect(remaining === 0 || remaining === 1).toBe(true);
  expect(remaining).toBeGreaterThanOrEqual(0);
});

test("price rules: discount reason when the price differs from the suggested one; credit needs a name", async () => {
  const { s, p1Lot, p2Lot } = await withShopStock();
  const p1 = (await s.t.run((ctx) => ctx.db.get("inventoryBatches", p1Lot)))!.productId;
  // Only products.set_price holders set the suggested price.
  await expect(s.as(s.agent).mutation(api.products.setSuggestedPrice, { productId: p1, price: 500 })).rejects.toThrow(
    /products\.set_price/,
  );
  await s.as(s.sales).mutation(api.products.setSuggestedPrice, { productId: p1, price: 500 });

  // At the suggested price: no reason needed. Below it: a reason is required.
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }]);
  const err = await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 400 }]).then(() => null, (e) => e);
  expect(err.data).toMatchObject({ code: "DISCOUNT_REASON", inventoryBatchId: p1Lot });
  const { saleId } = await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 400, discountReason: "Loyal customer" }]);
  // P2 has no suggested price: any price, reason optional.
  await sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1200 }]);

  // The price change later doesn't touch recorded sales.
  await s.as(s.sales).mutation(api.products.setSuggestedPrice, { productId: p1, price: 900 });
  const [item] = await s.t.run((ctx) => ctx.db.query("saleItems").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).collect());
  expect(item).toMatchObject({ unitPrice: 400, unitCostSnapshot: 200, suggestedPriceSnapshot: 500, discountReason: "Loyal customer" });

  // Credit needs the customer's name.
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1200 }], { paymentMethod: "credit" }),
  ).rejects.toThrow(/customer's name/);
  await sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 1200 }], { paymentMethod: "credit", customerName: "Mama Neema" });

  // Bad input.
  await expect(sell(s, s.agent, [])).rejects.toThrow(/at least one line/);
  await expect(sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 0, unitPrice: 100 }])).rejects.toThrow(/whole numbers from 1/);
  await expect(sell(s, s.agent, [{ inventoryBatchId: p2Lot, qty: 1, unitPrice: 12.5 }])).rejects.toThrow(/whole cents/);
  await expect(
    sell(s, s.agent, [
      { inventoryBatchId: p2Lot, qty: 1, unitPrice: 100 },
      { inventoryBatchId: p2Lot, qty: 1, unitPrice: 100 },
    ]),
  ).rejects.toThrow(/only once/);

  // Suggested price changes are audited with their currency.
  const priceAudit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "products" && a.entityId === p1).at(-1),
  );
  expect(priceAudit).toMatchObject({ before: { suggestedPrice: 500, currency: "USD" }, after: { suggestedPrice: 900, currency: "USD" } });
});

test("the sales list: agents see their location only; location and date filters", async () => {
  const { s, other, p1Lot } = await withShopStock();
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }]);
  await sell(s, s.sales, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 700 }], { locationId: other });

  const list = (who: Id<"users">, filters: Partial<{ locationId: Id<"locations">; from: string; to: string }> = {}) =>
    s.as(who).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: PAGE, ...filters });

  // The agent (own_location) sees only Goma Shop, even when asking for another.
  expect((await list(s.agent)).page.map((x) => x.locationName)).toEqual(["Goma Shop"]);
  expect((await list(s.agent, { locationId: other })).page.map((x) => x.locationName)).toEqual(["Goma Shop"]);
  // The chief sees everything, or one location.
  expect((await list(s.chief)).page.map((x) => x.locationName)).toEqual(["Other Shop", "Goma Shop"]);
  const otherOnly = (await list(s.chief, { locationId: other })).page;
  expect(otherOnly.map((x) => [x.locationName, x.soldByName, x.totalAmount, x.margin])).toEqual([["Other Shop", "Sales", 700, 500]]);
  expect(otherOnly[0].lines[0]).toMatchObject({ productName: "P1", batchNumber: "BATCH-00001", qty: 1, margin: 500 });

  // Business-day filters (Lubumbashi): sales made "today" match today, not tomorrow.
  const sale = (await s.t.run((ctx) => ctx.db.query("sales").collect()))[0];
  const today = new Date(sale.createdAt + 2 * 3600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(sale.createdAt + 26 * 3600_000).toISOString().slice(0, 10);
  expect((await list(s.chief, { from: today, to: today })).page).toHaveLength(2);
  expect((await list(s.chief, { from: tomorrow })).page).toHaveLength(0);
  await expect(list(s.chief, { from: "29/09/2026" })).rejects.toThrow(/YYYY-MM-DD/);

  // Filter locations follow the same scope.
  expect(await s.as(s.agent).query(api.sales.filterLocations, { businessUnitKey: "hair" })).toMatchObject({
    locked: true,
    locations: [{ name: "Goma Shop" }],
  });
  expect((await s.as(s.chief).query(api.sales.filterLocations, { businessUnitKey: "hair" })).locations).toHaveLength(2);

  // Without sales.view, nothing.
  await expect(list(s.inventory)).rejects.toThrow(/sales\.view/);
});

test("an agent without a location can't sell", async () => {
  const { s, p1Lot } = await withShopStock();
  const lost = await insertUserWithRole(s.t, "sales_agent", { email: "lost@x.com" });
  await expect(sell(s, lost, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }])).rejects.toThrow(/no location/);
});

test("saleLineProblems and lineMargin", () => {
  expect(saleLineProblems({ qty: 1, unitPrice: 500 }, 500)).toEqual([]);
  expect(saleLineProblems({ qty: 1, unitPrice: 450 }, 500)).toEqual(["discountReason"]);
  expect(saleLineProblems({ qty: 1, unitPrice: 450, discountReason: " " }, 500)).toEqual(["discountReason"]);
  expect(saleLineProblems({ qty: 1, unitPrice: 450, discountReason: "Offer" }, 500)).toEqual([]);
  expect(saleLineProblems({ qty: 1, unitPrice: 450 }, undefined)).toEqual([]);
  expect(saleLineProblems({ qty: 0, unitPrice: -1 }, undefined)).toEqual(["qty", "price"]);
  expect(lineMargin({ qty: 3, unitPrice: 500, unitCostSnapshot: 200 })).toBe(900);
  expect(lineMargin({ qty: 1, unitPrice: 100, unitCostSnapshot: 200 })).toBe(-100);
});

test("the price list: selling price next to each lot's purchase cost, on hand and last sale", async () => {
  const { s, p1Lot } = await withShopStock();
  const p1 = (await s.t.run((ctx) => ctx.db.get("inventoryBatches", p1Lot)))!.productId;
  await s.as(s.sales).mutation(api.products.setSuggestedPrice, { productId: p1, price: 500 });
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 450, discountReason: "Offer" }]);

  const priceList = (who: Id<"users">, search?: string) =>
    s.as(who).query(api.products.priceList, { businessUnitKey: "hair", paginationOpts: PAGE, ...(search ? { search } : {}) });

  // Sales Agent (sales access) sees costs too, as decided.
  const rows = (await priceList(s.agent)).page;
  const row = rows.find((r) => r.name === "P1")!;
  expect(row).toMatchObject({
    suggestedPrice: 500,
    // 10 bought: 2 sold, so 8 left (4 at Goma Shop, 2 at Other Shop, 2 with the business).
    onHand: 8,
    minCost: 200,
    maxCost: 200,
    lastSold: { unitPrice: 450 },
  });
  expect(row.lots).toEqual([
    expect.objectContaining({ batchNumber: "BATCH-00001", unitCost: 200, receivedQty: 10, onHand: 8, marginAtSuggested: 300 }),
  ]);
  // A product never bought and without a price.
  expect(rows.find((r) => r.name === "P4")).toMatchObject({ suggestedPrice: null, lots: [], onHand: 0, minCost: null, lastSold: null });

  // Stock access (Chief Inventory Admin) and the Chief Admin can read it; search works.
  expect((await priceList(s.inventory, "P2")).page.map((r) => r.name)).toEqual(["P2"]);
  expect((await priceList(s.chief)).page.length).toBeGreaterThan(0);

  // Archived products are hidden.
  await s.t.run((ctx) => ctx.db.patch("products", s.p4, { status: "archived" }));
  expect((await priceList(s.chief)).page.find((r) => r.name === "P4")).toBeUndefined();

  // A role with products.view but neither stock nor sales access is refused.
  const viewerRole = await s.t.run(async (ctx) => {
    const roleId = await ctx.db.insert("roles", { key: "viewer", name: "Viewer", description: "", isSystem: false });
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "products.view")!;
    await ctx.db.insert("rolePermissions", { roleId, permissionId: permission._id, scope: "all_locations" });
    return roleId;
  });
  const viewer = await s.t.run((ctx) =>
    ctx.db.insert("users", { name: "V", email: "v@x.com", roleId: viewerRole, status: "active", mustChangePassword: false, createdBy: null }),
  );
  await expect(priceList(viewer)).rejects.toThrow(/stock or sales access/);
});

test("a sale recorded late can be dated up to 7 days back, never in the future", async () => {
  const { s, p1Lot, shop } = await withShopStock();
  const today = businessDayOf(Date.now());
  const yesterday = addBusinessDays(today, -1);

  const { saleId, soldOn } = await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { soldOn: yesterday });
  expect(soldOn).toBe(yesterday);
  const sale = (await s.t.run((ctx) => ctx.db.get("sales", saleId)))!;
  expect(businessDayOf(sale.createdAt)).toBe(yesterday);
  expect(businessDayOf(sale.recordedAt!)).toBe(today);
  // Stock still went through applyMovement.
  expect(await onHand(s, p1Lot, shop)).toBe(5);

  // Today's sale (no date given) isn't backdated.
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }]);

  const list = (from: string, to: string) =>
    s.as(s.chief).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: PAGE, from, to });
  const onYesterday = (await list(yesterday, yesterday)).page;
  expect(onYesterday.map((x) => [x.number, x.backdated])).toEqual([["SALE-00001", true]]);
  expect((await list(today, today)).page.map((x) => [x.number, x.backdated])).toEqual([["SALE-00002", false]]);

  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find((a) => a.entityTable === "sales" && a.entityId === saleId),
  );
  expect(audit!.after).toMatchObject({ soldOn: yesterday, backdated: true, recordedOn: today });

  // Limits: 7 days back is fine; 8 days back, tomorrow and bad dates aren't.
  await sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { soldOn: addBusinessDays(today, -7) });
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { soldOn: addBusinessDays(today, -8) }),
  ).rejects.toThrow(/last 7 days/);
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { soldOn: addBusinessDays(today, 1) }),
  ).rejects.toThrow(/future/);
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }], { soldOn: "29/09/2026" }),
  ).rejects.toThrow(/YYYY-MM-DD/);
  // A backdated sale can't oversell either (3 left).
  await expect(
    sell(s, s.agent, [{ inventoryBatchId: p1Lot, qty: 4, unitPrice: 500 }], { soldOn: yesterday }),
  ).rejects.toThrow(/Only 3 left/);
});

test("saleTimestamp keeps the clock time inside the chosen business day", () => {
  // 10:30 in Lubumbashi on 30 Sep = 08:30 UTC.
  const now = Date.UTC(2026, 8, 30, 8, 30);
  expect(saleTimestamp(undefined, now)).toEqual({ createdAt: now, backdated: false });
  expect(saleTimestamp("2026-09-30", now)).toEqual({ createdAt: now, backdated: false });
  const back = saleTimestamp("2026-09-28", now);
  expect(back).toEqual({ createdAt: businessDayStartUtc("2026-09-28") + 10.5 * 3600_000, backdated: true });
  expect(saleTimestamp("2026-09-23", now)).toMatchObject({ backdated: true });
  expect(saleTimestamp("2026-09-22", now)).toEqual({ problem: "tooOld" });
  expect(saleTimestamp("2026-10-01", now)).toEqual({ problem: "future" });
  expect(saleTimestamp("2026-02-30", now)).toEqual({ problem: "invalid" });
  // 23:30 in Lubumbashi (21:30 UTC) is still that day.
  const late = Date.UTC(2026, 8, 30, 21, 30);
  expect(businessDayOf((saleTimestamp("2026-09-29", late) as { createdAt: number }).createdAt)).toBe("2026-09-29");
});
