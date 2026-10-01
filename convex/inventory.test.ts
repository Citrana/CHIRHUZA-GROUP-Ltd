import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { appendOnlyGuardedDb } from "./lib/rbac";
import {
  applyMovement,
  businessHolderRef,
  getOrCreateHolder,
  groupStock,
  stockLevelOf,
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

test("only convex/lib/inventory.ts writes stock levels or movements", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true });
  const writes = (table: string, ops: string) => new RegExp(`\\.(${ops})\\(\\s*["'\`]${table}["'\`]`);
  const offenders = Object.entries(sources)
    .filter(([path]) => !path.includes("_generated") && !path.endsWith(".test.ts") && path !== "./lib/inventory.ts")
    .filter(
      ([, source]) =>
        writes("stockLevels", "insert|patch|replace|delete").test(source as string) ||
        writes("inventoryMovements", "insert|patch|replace|delete").test(source as string),
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
