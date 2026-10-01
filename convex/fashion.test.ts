import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { businessDayOf } from "./lib/time";
import { getBusinessUnitId, insertLocation, insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };

/**
 * Mode (fashion): clothes are told apart by name, colour and SIZE (sizes
 * are a managed, ordered list in the service's product settings). The
 * rest of the platform (requisitions -> stock -> sales -> analytics) is
 * the same as for hair.
 */
async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const fashionId = await getBusinessUnitId(t, "fashion");
  const shop = await insertLocation(t, { name: "Boutique Mode" });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const sales = await insertUserWithRole(t, "chief_sales_admin", { email: "sales@x.com", name: "Sales" });
  const inventory = await insertUserWithRole(t, "chief_inventory_admin", { email: "inv@x.com", name: "Buyer" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Goma" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", name: "Agent", locationId: shop });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  // Chief Admin holds products.settings: sizes and colours.
  const size = (name: string) => as(chief).mutation(api.productOptions.addSize, { businessUnitKey: "fashion", name });
  const [s, m, l] = [await size("S"), await size("M"), await size("L")];
  const red = await as(chief).mutation(api.productOptions.addColour, { businessUnitKey: "fashion", name: "Red" });
  return { t, fashionId, shop, chief, sales, inventory, manager, agent, as, sizes: { s, m, l }, red };
}
type S = Awaited<ReturnType<typeof setup>>;

type ProductArgs = FunctionArgs<typeof api.products.create>;

const dress = (s: S, extra: Partial<ProductArgs> = {}) =>
  s.as(s.chief).mutation(api.products.create, {
    businessUnitKey: "fashion",
    name: "Robe wax",
    category: "dresses",
    unit: "piece",
    sizeId: s.sizes.m,
    colourId: s.red,
    ...extra,
  });

test("a fashion product has a size and colour, a FASH SKU, and is searchable by size", async () => {
  const s = await setup();
  const productId = await dress(s);
  const product = await s.as(s.agent).query(api.products.get, { productId });
  expect(product).toMatchObject({ sku: "FASH-00001", category: "dresses", sizeName: "M", colourName: "Red", status: "active" });
  const search = (term: string) =>
    s.as(s.agent).query(api.products.list, { businessUnitKey: "fashion", search: term, paginationOpts: PAGE });
  expect((await search("m")).page.map((p) => p.name)).toEqual(["Robe wax"]);
  expect((await search("red")).page.map((p) => p.sizeName)).toEqual(["M"]);
});

test("the service's profile is enforced: categories, units, length vs size", async () => {
  const s = await setup();
  await expect(dress(s, { category: "wigs" })).rejects.toThrow(/category isn't used/);
  await expect(dress(s, { unit: "bottle" })).rejects.toThrow(/unit isn't used/);
  await expect(dress(s, { lengthInches: 18 })).rejects.toThrow(/have no length/);
  await expect(dress(s, { texture: "Silky" })).rejects.toThrow(/have no texture/);
  // A size on a hair product, or a size from another service.
  await expect(
    s.as(s.chief).mutation(api.products.create, {
      businessUnitKey: "hair",
      name: "Wig",
      category: "wigs",
      unit: "piece",
      sizeId: s.sizes.m,
    }),
  ).rejects.toThrow(/have no size/);
  // An inactive size can't be picked.
  await s.as(s.chief).mutation(api.productOptions.setSizeActive, { sizeId: s.sizes.l, active: false });
  await expect(dress(s, { sizeId: s.sizes.l })).rejects.toThrow(/size from the product settings/);
  // Shoes come in pairs.
  await dress(s, { name: "Sandales", category: "shoes", unit: "pair", sizeId: s.sizes.s });
});

test("sizes: unique, ordered, renamed (search follows), deleted only when unused", async () => {
  const s = await setup();
  const list = async () =>
    (await s.as(s.agent).query(api.productOptions.listSizes, { businessUnitKey: "fashion", includeInactive: true })).map((x) => [
      x.name,
      x.productCount,
    ]);
  expect(await list()).toEqual([["S", 0], ["M", 0], ["L", 0]]);
  await expect(s.as(s.chief).mutation(api.productOptions.addSize, { businessUnitKey: "fashion", name: " m " })).rejects.toThrow();
  await expect(s.as(s.agent).mutation(api.productOptions.addSize, { businessUnitKey: "fashion", name: "XL" })).rejects.toThrow(
    /products\.settings/,
  );
  await s.as(s.chief).mutation(api.productOptions.moveSize, { sizeId: s.sizes.l, direction: "up" });
  expect((await list()).map(([n]) => n)).toEqual(["S", "L", "M"]);

  const productId = await dress(s);
  expect(await list()).toContainEqual(["M", 1]);
  await s.as(s.chief).mutation(api.productOptions.renameSize, { sizeId: s.sizes.m, name: "Medium" });
  const found = await s.as(s.agent).query(api.products.list, { businessUnitKey: "fashion", search: "medium", paginationOpts: PAGE });
  expect(found.page.map((p) => p._id)).toEqual([productId]);
  await expect(s.as(s.chief).mutation(api.productOptions.deleteSize, { sizeId: s.sizes.m })).rejects.toThrow();
  await s.as(s.chief).mutation(api.productOptions.deleteSize, { sizeId: s.sizes.s });
  expect((await list()).map(([n]) => n)).toEqual(["L", "Medium"]);
});

test("Mode end to end: requisition -> purchase -> receive -> distribute -> sale -> analytics", async () => {
  const s = await setup();
  const productId = await dress(s);

  // Requisition from the Mode shop, approved.
  const requisitionId = await s.as(s.sales).mutation(api.requisitions.create, { businessUnitKey: "fashion", locationId: s.shop });
  const lineId = await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId, productId, qtyRequested: 5 });
  const reqApproval = await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: reqApproval, decision: "approve" });

  // Purchased abroad at $12, approved, shipped, arrived, received.
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "fashion", title: "Dubai" });
  await s.as(s.inventory).mutation(api.stockBatches.addRequisitionLines, { batchId, requisitionItemIds: [lineId] });
  const [item] = await s.t.run((ctx) =>
    ctx.db.query("stockBatchItems").withIndex("by_batchId", (q) => q.eq("batchId", batchId)).collect(),
  );
  await s.as(s.inventory).mutation(api.stockBatches.updateItem, { itemId: item._id, status: "purchased", qtyPurchased: 5, unitCost: 1200 });
  await s.as(s.inventory).mutation(api.stockBatches.markPurchased, { batchId });
  const batchApproval = await s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: batchApproval, decision: "approve" });
  await s.as(s.inventory).mutation(api.stockBatches.markShipped, { batchId });
  await s.as(s.manager).mutation(api.stockBatches.markArrived, { batchId });
  await s.as(s.manager).mutation(api.stockBatches.setReceiveCount, { itemId: item._id, qtyReceived: 5, qtyDamaged: 0 });
  await s.as(s.manager).mutation(api.stockBatches.confirmReceipt, { batchId });

  // To the shop, then sold by the agent at $25.
  const [lot] = await s.t.run((ctx) => ctx.db.query("inventoryBatches").collect());
  await s.t.run(async (ctx) =>
    applyMovement(ctx, {
      type: "distribute",
      inventoryBatchId: lot._id,
      fromHolderId: await getOrCreateHolder(ctx, s.fashionId, businessHolderRef(s.fashionId)),
      toHolderId: await getOrCreateHolder(ctx, s.fashionId, { type: "location", refId: s.shop }),
      qty: 5,
      refTable: "test",
      refId: "setup",
      actorId: s.chief,
    }),
  );
  const options = await s.as(s.agent).query(api.sales.options, { businessUnitKey: "fashion" });
  expect(options.lots.map((l) => [l.productName, l.sizeName, l.colourName, l.onHand])).toEqual([["Robe wax", "M", "Red", 5]]);
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "fashion",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: lot._id, qty: 2, unitPrice: 2500 }],
  });

  // Mode's analytics are its own; Hair's are untouched.
  const today = businessDayOf(Date.now());
  const summary = (businessUnitKey: "fashion" | "hair") =>
    s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey, range: { from: today, to: today } });
  expect(await summary("fashion")).toMatchObject({ sales: 5000, cost: 2400, margin: 2600 });
  expect(await summary("hair")).toMatchObject({ sales: 0, margin: 0 });
  const top = await s.as(s.chief).query(api.analytics.getTopProducts, {
    businessUnitKey: "fashion",
    range: { preset: "today" },
    by: "units",
    order: "desc",
  });
  expect(top.products.map((p) => [p.name, p.sizeName, p.unitsSold])).toEqual([["Robe wax", "M", 2]]);
});

test("one shop, two services: shared location, separate stock, sales and analytics", async () => {
  const s = await setup();
  const hairId = await getBusinessUnitId(s.t, "hair");
  const dressId = await dress(s);
  const wigId = await s.as(s.chief).mutation(api.products.create, {
    businessUnitKey: "hair",
    name: "Perruque",
    category: "wigs",
    unit: "piece",
  });

  // Stock of each service lands at the SAME shop (Boutique Mode).
  const stockAt = (unitId: Id<"businessUnits">, productId: Id<"products">, unitCost: number, qty: number) =>
    s.t.run(async (ctx) => {
      const batchId = await ctx.db.insert("stockBatches", {
        businessUnitId: unitId,
        number: `B-${unitCost}`,
        title: "Seed",
        status: "received",
        currency: "USD",
        createdBy: s.chief,
      });
      const itemId = await ctx.db.insert("stockBatchItems", {
        batchId,
        productId,
        status: "purchased",
        qtyRequested: 0,
        qtyPurchased: qty,
        unitCost,
        currency: "USD",
      });
      const lotId = await ctx.db.insert("inventoryBatches", {
        businessUnitId: unitId,
        productId,
        sourceStockBatchItemId: itemId,
        stockBatchId: batchId,
        unitCost,
        currency: "USD",
        receivedQty: qty,
        createdAt: Date.now(),
      });
      await applyMovement(ctx, {
        type: "receive",
        inventoryBatchId: lotId,
        toHolderId: await getOrCreateHolder(ctx, unitId, { type: "location", refId: s.shop }),
        qty,
        refTable: "test",
        refId: "seed",
        actorId: s.chief,
      });
      return lotId;
    });
  const dressLot = await stockAt(s.fashionId, dressId, 1200, 4);
  const wigLot = await stockAt(hairId, wigId, 3000, 2);

  // Each service sees the shop, and only its own stock there.
  const options = (businessUnitKey: "hair" | "fashion") =>
    s.as(s.sales).query(api.sales.options, { businessUnitKey, locationId: s.shop });
  expect((await options("fashion")).locations.map((l) => l.name)).toContain("Boutique Mode");
  expect((await options("fashion")).lots.map((l) => l.productName)).toEqual(["Robe wax"]);
  expect((await options("hair")).lots.map((l) => l.productName)).toEqual(["Perruque"]);

  // The shop's agent sells in either service; each sale only takes its own stock.
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "fashion",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: dressLot, qty: 1, unitPrice: 2500 }],
  });
  await expect(
    s.as(s.agent).mutation(api.sales.create, {
      businessUnitKey: "fashion",
      paymentMethod: "cash",
      lines: [{ inventoryBatchId: wigLot, qty: 1, unitPrice: 5000 }],
    }),
  ).rejects.toThrow(/Stock lot not found/);
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: wigLot, qty: 1, unitPrice: 5000 }],
  });
  expect((await options("fashion")).lots.map((l) => l.onHand)).toEqual([3]);
  expect((await options("hair")).lots.map((l) => l.onHand)).toEqual([1]);

  // Analytics for the same shop stay per service.
  const today = businessDayOf(Date.now());
  const summary = (businessUnitKey: "hair" | "fashion") =>
    s.as(s.chief).query(api.analytics.getSummary, { businessUnitKey, range: { from: today, to: today }, locationId: s.shop });
  expect(await summary("fashion")).toMatchObject({ sales: 2500, cost: 1200 });
  expect(await summary("hair")).toMatchObject({ sales: 5000, cost: 3000 });

  // Payroll and requisitions offer the shop in both services.
  for (const businessUnitKey of ["hair", "fashion"] as const) {
    const payrollOptions = await s.as(s.chief).query(api.payroll.options, { businessUnitKey });
    expect(payrollOptions.locations.map((l) => l.name)).toContain("Boutique Mode");
    const requisitionLocations = await s.as(s.sales).query(api.requisitions.locationOptions, { businessUnitKey });
    expect(requisitionLocations.map((l) => l.name)).toContain("Boutique Mode");
  }
});
