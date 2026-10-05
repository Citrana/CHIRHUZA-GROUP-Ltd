import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { appendOnlyGuardedDb } from "./lib/rbac";
import {
  applyMovement,
  businessHolderRef,
  getOrCreateHolder,
  groupStock,
  nextProductStock,
  stockLevelOf,
  stockStatus,
} from "./lib/inventory";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";

const modules = import.meta.glob("./**/*.*s");

/** A received mixed batch: the business holds 10 / 3 / 3 units in three lots. */
async function received() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!; // 10 units
  const holders = await s.t.run(async (ctx) => ({
    business: await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId)),
    shop: await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop }),
  }));
  return { s, b, lot, lots, ...holders };
}

async function onHand(s: Setup, lot: Id<"inventoryBatches">, holder: Id<"holders">) {
  return (await s.t.run((ctx) => stockLevelOf(ctx, lot, holder)))?.qtyOnHand ?? 0;
}

const move = (s: Setup, m: Omit<Parameters<typeof applyMovement>[1], "refTable" | "refId" | "actorId">) =>
  s.t.run((ctx) => applyMovement(ctx, { ...m, refTable: "test", refId: "t", actorId: s.chief }));

test("a movement takes from one holder and gives to the other, and is logged", async () => {
  const { s, lot, business, shop } = await received();
  await move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty: 4 });
  expect(await onHand(s, lot._id, business)).toBe(6);
  expect(await onHand(s, lot._id, shop)).toBe(4);
  const movements = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_inventoryBatchId", (q) => q.eq("inventoryBatchId", lot._id)).collect(),
  );
  expect(movements.map((m) => [m.type, m.qty])).toEqual([["receive", 10], ["distribute", 4]]);
  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "inventoryMovements"),
  );
  expect(audit.at(-1)!.after).toMatchObject({ type: "distribute", from: "business", to: "Goma Shop", qty: 4, fromOnHand: "10 → 6" });
});

test("stock never goes negative: taking more than on hand throws and changes nothing", async () => {
  const { s, lot, business, shop } = await received();
  await expect(
    move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty: 11 }),
  ).rejects.toThrow(/Not enough stock: 10 on hand, 11 requested/);
  // Nothing moved, nothing logged.
  expect(await onHand(s, lot._id, business)).toBe(10);
  expect(await onHand(s, lot._id, shop)).toBe(0);
  // A holder that never had the lot can't give any.
  await expect(
    move(s, { type: "transfer", inventoryBatchId: lot._id, fromHolderId: shop, toHolderId: business, qty: 1 }),
  ).rejects.toThrow(/0 on hand, 1 requested/);
  // Exactly everything can go; then nothing more.
  await move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty: 10 });
  expect(await onHand(s, lot._id, business)).toBe(0);
  await expect(
    move(s, { type: "sale", inventoryBatchId: lot._id, fromHolderId: business, qty: 1 }),
  ).rejects.toThrow(/Not enough stock/);
  const movements = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_inventoryBatchId", (q) => q.eq("inventoryBatchId", lot._id)).collect(),
  );
  expect(movements.map((m) => m.qty)).toEqual([10, 10]);
});

test("quantities must be whole and positive; a movement needs a side", async () => {
  const { s, lot, business, shop } = await received();
  for (const qty of [0, -3, 1.5, Number.NaN]) {
    await expect(
      move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty }),
    ).rejects.toThrow(/whole number greater than 0/);
  }
  await expect(move(s, { type: "adjustment", inventoryBatchId: lot._id, qty: 1 })).rejects.toThrow(/source or a destination/);
  await expect(
    move(s, { type: "transfer", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: business, qty: 1 }),
  ).rejects.toThrow(/must differ/);
  expect(await onHand(s, lot._id, business)).toBe(10);
});

test("movements are append-only at runtime", async () => {
  const { s } = await received();
  const [movement] = await s.t.run((ctx) => ctx.db.query("inventoryMovements").take(1));
  await expect(
    s.t.run((ctx) => appendOnlyGuardedDb(ctx).patch("inventoryMovements", movement._id, { qty: 999 })),
  ).rejects.toThrow();
  await expect(s.t.run((ctx) => appendOnlyGuardedDb(ctx).delete("inventoryMovements", movement._id))).rejects.toThrow();
});

test("only convex/lib/inventory.ts writes stock levels, movements or product stock summaries", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true });
  const writes = (table: string, ops: string) => new RegExp(`\\.(${ops})\\(\\s*["'\`]${table}["'\`]`);
  const offenders = Object.entries(sources)
    .filter(([path]) => !path.includes("_generated") && !path.endsWith(".test.ts") && path !== "./lib/inventory.ts")
    .filter(
      ([, source]) =>
        writes("stockLevels", "insert|patch|replace|delete").test(source as string) ||
        writes("inventoryMovements", "insert|patch|replace|delete").test(source as string) ||
        writes("productStock", "insert|patch|replace|delete").test(source as string),
    )
    .map(([path]) => path);
  expect(Object.keys(sources).length).toBeGreaterThan(5);
  expect(offenders).toEqual([]);
  // ...and even there, movements are only ever inserted.
  expect(writes("inventoryMovements", "patch|replace|delete").test(sources["./lib/inventory.ts"] as string)).toBe(false);
});

test("the overview's three views agree", async () => {
  const { s, lots, business, shop } = await received();
  await move(s, { type: "distribute", inventoryBatchId: lots[0]._id, fromHolderId: business, toHolderId: shop, qty: 2 });
  const overview = await s.as(s.chief).query(api.inventory.overview, { businessUnitKey: "hair" });
  const total = (xs: { qty: number }[]) => xs.reduce((sum, x) => sum + x.qty, 0);
  expect(total(overview.byProduct)).toBe(16);
  expect(total(overview.byLot)).toBe(16);
  expect(total(overview.byHolder)).toBe(16);
  expect(overview.byHolder.map((h) => [h.holder.name, h.qty])).toEqual([["business", 14], ["Goma Shop", 2]]);
  // Value = qty × purchase unit cost: 10×$2 + 3×$10 + 3×$5 = $65.
  expect(overview.byHolder.reduce((sum, h) => sum + h.value, 0)).toBe(6500);
});

test("groupStock ignores empty levels", () => {
  const row = (qty: number) => ({
    qty,
    holder: { id: "h" as Id<"holders">, type: "business" as const, name: "business" },
    lot: { id: "l" as Id<"inventoryBatches">, batchNumber: "BATCH-1", unitCost: 100, receivedQty: 5, createdAt: 1 },
    product: { id: "p" as Id<"products">, name: "P", sku: "S", lengthInches: null, sizeName: null, colourName: null },
  });
  expect(groupStock([row(0)])).toEqual({ byProduct: [], byLot: [], byHolder: [] });
  expect(groupStock([row(5)]).byProduct[0]).toMatchObject({ qty: 5, value: 500 });
});


const PAGE = { numItems: 50, cursor: null };

test("product stock report: finished products stay listed, with totals, status and history", async () => {
  const { s, lot, business, shop } = await received();
  const summary = async (productName: string) => {
    const rows = (await s.as(s.chief).query(api.inventory.productReport, { businessUnitKey: "hair", paginationOpts: PAGE })).page;
    return rows.find((r) => r.name === productName)!;
  };
  // Received: P1 has 10 with the business.
  expect(await summary("P1")).toMatchObject({ status: "in_stock", received: 10, sold: 0, onHand: 10, outOfStockSince: null });
  expect((await summary("P1")).lastReceivedAt).toBeTypeOf("number");
  // Never stocked products are listed too.
  expect(await summary("P4")).toMatchObject({ status: "never", onHand: 0, received: 0 });

  // To the shop (on hand unchanged), then sold out by the shop's agent.
  await move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty: 10 });
  expect(await summary("P1")).toMatchObject({ onHand: 10, status: "in_stock" });
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: lot._id, qty: 10, unitPrice: 500 }],
  });
  const p1 = await summary("P1");
  expect(p1).toMatchObject({ status: "out", received: 10, sold: 10, onHand: 0 });
  expect(p1.outOfStockSince).toBeTypeOf("number");
  expect(p1.lastSoldAt).toBeTypeOf("number");

  // Filters and counts.
  const byStatus = async (status: "in_stock" | "low" | "out" | "never") =>
    (await s.as(s.chief).query(api.inventory.productReport, { businessUnitKey: "hair", status, paginationOpts: PAGE })).page.map(
      (r) => r.name,
    );
  expect(await byStatus("out")).toEqual(["P1"]);
  expect((await byStatus("never")).sort()).toEqual(["P3", "P4"]);
  expect(await s.as(s.chief).query(api.inventory.statusCounts, { businessUnitKey: "hair" })).toEqual({
    in_stock: 2, // P2 and the new closure
    low: 0,
    out: 1,
    never: 2,
  });
  const searched = await s.as(s.chief).query(api.inventory.productReport, { businessUnitKey: "hair", search: "P1", paginationOpts: PAGE });
  expect(searched.page.map((r) => r.name)).toEqual(["P1"]);

  // Low-stock threshold (products.set_price): P2 has 3 -> low at 3.
  const p2 = (await summary("P2")).productId;
  await expect(s.as(s.agent).mutation(api.products.setLowStockThreshold, { productId: p2, threshold: 3 })).rejects.toThrow(
    /products\.set_price/,
  );
  await s.as(s.sales).mutation(api.products.setLowStockThreshold, { productId: p2, threshold: 3 });
  expect(await summary("P2")).toMatchObject({ status: "low", lowStockThreshold: 3 });
  expect(await byStatus("low")).toEqual(["P2"]);
  await s.as(s.sales).mutation(api.products.setLowStockThreshold, { productId: p2, threshold: null });
  expect((await summary("P2")).status).toBe("in_stock");

  // History: received, sent to the shop, sold - newest first, with references and running totals.
  const detail = await s.as(s.chief).query(api.inventory.productStockDetail, { productId: p1.productId });
  expect(detail!.holders).toEqual([]);
  expect(detail!.history.map((h) => [h.type, h.qty, h.balance, h.to?.name ?? null])).toEqual([
    ["sale", 10, 0, null],
    ["distribute", 10, 10, "Goma Shop"],
    ["receive", 10, 10, "business"],
  ]);
  expect(detail!.history[0].reference).toBe("SALE-00001");
  expect(detail!.history[2].reference).toBe("BATCH-00001");

  // Restocking clears "out of stock since".
  const p2Lot = (await s.t.run((ctx) => ctx.db.query("inventoryBatches").collect())).find((l) => l.productId === p2)!;
  await move(s, { type: "distribute", inventoryBatchId: p2Lot._id, fromHolderId: business, toHolderId: shop, qty: 1 });
  expect(await s.as(s.chief).query(api.inventory.productReportExport, { businessUnitKey: "hair", status: "out" })).toHaveLength(1);
});

test("product stock summaries equal a rebuild from the movements", async () => {
  const { s, lot, business, shop } = await received();
  await move(s, { type: "distribute", inventoryBatchId: lot._id, fromHolderId: business, toHolderId: shop, qty: 6 });
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: lot._id, qty: 6, unitPrice: 500 }],
  });
  const snapshot = () =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("productStock").collect())
        .map(({ _id, _creationTime, ...rest }) => {
          void _id;
          void _creationTime;
          return JSON.stringify(rest);
        })
        .sort(),
    );
  const incremental = await snapshot();
  expect(incremental.length).toBe(3);
  const result = await s.t.mutation(internal.inventory.rebuildProductStock, { businessUnitKey: "hair" });
  expect(result).toEqual({ products: 3 });
  expect(await snapshot()).toEqual(incremental);
});

test("nextProductStock: totals, status and out-of-stock dates", () => {
  let state = nextProductStock(null, { type: "receive", qty: 5, hasFrom: false, hasTo: true }, 100);
  expect(state).toEqual({ received: 5, sold: 0, onHand: 5, lastReceivedAt: 100 });
  state = nextProductStock(state, { type: "distribute", qty: 5, hasFrom: true, hasTo: true }, 200);
  expect(state.onHand).toBe(5);
  state = nextProductStock(state, { type: "sale", qty: 5, hasFrom: true, hasTo: false }, 300);
  expect(state).toMatchObject({ sold: 5, onHand: 0, lastSoldAt: 300, outOfStockSince: 300 });
  state = nextProductStock(state, { type: "receive", qty: 2, hasFrom: false, hasTo: true }, 400);
  expect(state.outOfStockSince).toBeUndefined();
  expect(stockStatus(0, undefined)).toBe("out");
  expect(stockStatus(3, 3)).toBe("low");
  expect(stockStatus(4, 3)).toBe("in_stock");
});
