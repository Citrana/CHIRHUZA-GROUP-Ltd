import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder, stockLevelOf } from "./lib/inventory";
import { PAGE, arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertLocation, insertUserWithRole } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/**
 * Received mixed batch, then 6 of P1 ($2.00 cost) and 3 of P2 ($10.00)
 * moved to Goma Shop. The manager counts and reviews (stock.count.record +
 * review); the Chief Admin approves (stock.count.approve).
 */
async function withShopStock() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const p1Lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!._id;
  const p2Lot = lots.find((l) => l.sourceStockBatchItemId === b.i2._id)!._id;
  const shopHolder = await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    const shop = await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop });
    for (const [lot, qty] of [[p1Lot, 6], [p2Lot, 3]] as const) {
      await applyMovement(ctx, {
        type: "distribute",
        inventoryBatchId: lot,
        fromHolderId: business,
        toHolderId: shop,
        qty,
        refTable: "test",
        refId: "setup",
        actorId: s.chief,
      });
    }
    return shop;
  });
  return { s, p1Lot, p2Lot, shopHolder };
}

const startAtShop = (s: Setup, who = s.manager) =>
  s.as(who).mutation(api.stockCounts.start, {
    businessUnitKey: "hair",
    holder: { type: "location", id: s.shop },
    scope: { kind: "all" },
  });

async function lineOf(s: Setup, countId: Id<"stockCounts">, product: string, who = s.chief) {
  const count = (await s.as(who).query(api.stockCounts.get, { countId }))!;
  return count.lines.find((l) => l.productName === product)!;
}

const onHand = async (s: Setup, lot: Id<"inventoryBatches">, holder: Id<"holders">) =>
  (await s.t.run((ctx) => stockLevelOf(ctx, lot, holder)))?.qtyOnHand ?? 0;

const productStockOf = (s: Setup, product: Id<"products">) =>
  s.t.run((ctx) => ctx.db.query("productStock").withIndex("by_productId", (q) => q.eq("productId", product)).unique());

const adjustmentsOf = (s: Setup, countId: Id<"stockCounts">) =>
  s.t.run((ctx) => ctx.db.query("stockAdjustments").withIndex("by_stockCountId", (q) => q.eq("stockCountId", countId)).collect());

/** Counts every line: `counts` maps product name -> counted quantity. */
async function countAll(s: Setup, countId: Id<"stockCounts">, counts: Record<string, number>, who = s.manager) {
  for (const [product, qty] of Object.entries(counts)) {
    const line = await lineOf(s, countId, product);
    await s.as(who).mutation(api.stockCounts.saveCount, { itemId: line._id, countedQty: qty });
  }
}

test("starting a count freezes expected quantities; later movements don't change them", async () => {
  const { s, p1Lot, shopHolder } = await withShopStock();
  const countId = await startAtShop(s);

  const items = await s.t.run((ctx) =>
    ctx.db.query("stockCountItems").withIndex("by_stockCountId", (q) => q.eq("stockCountId", countId)).collect(),
  );
  expect(items.map((i) => [i.expectedQty, i.unitCost]).sort()).toEqual([[3, 1000], [6, 200]]);

  // Stock leaves the shop after the snapshot: the frozen figures stay.
  await s.t.run((ctx) =>
    applyMovement(ctx, { type: "sale", inventoryBatchId: p1Lot, fromHolderId: shopHolder, qty: 2, refTable: "test", refId: "x", actorId: s.chief }),
  );
  const after = await s.t.run((ctx) =>
    ctx.db.query("stockCountItems").withIndex("by_stockCountId", (q) => q.eq("stockCountId", countId)).collect(),
  );
  expect(after.map((i) => i.expectedQty).sort()).toEqual([3, 6]);

  // Only one open count per holder.
  await expect(startAtShop(s)).rejects.toThrow(/still open/);
  const [row] = (await s.as(s.manager).query(api.stockCounts.list, { businessUnitKey: "hair", paginationOpts: PAGE })).page;
  expect(row).toMatchObject({ number: "CNT-00001", status: "counting", itemCount: 2, holder: { type: "location", name: "Goma Shop" } });
});

test("counting is blind: expected quantities are hidden unless an approver asks", async () => {
  const { s } = await withShopStock();
  const countId = await startAtShop(s);

  const blind = (await s.as(s.manager).query(api.stockCounts.get, { countId }))!;
  expect(blind.blind).toBe(true);
  expect(blind.totals).toBeNull();
  expect(blind.lines.every((l) => l.expectedQty === null && l.difference === null)).toBe(true);
  // A counter can't lift it by asking.
  expect((await s.as(s.manager).query(api.stockCounts.get, { countId, showExpected: true }))!.blind).toBe(true);
  // An approver (owner) can.
  const shown = (await s.as(s.chief).query(api.stockCounts.get, { countId, showExpected: true }))!;
  expect(shown.blind).toBe(false);
  expect(shown.lines.map((l) => [l.productName, l.expectedQty])).toEqual([["P1", 6], ["P2", 3]]);
});

test("a sale during the count is not taken for a loss", async () => {
  const { s, p1Lot, shopHolder } = await withShopStock();
  const countId = await startAtShop(s);

  // 2 of P1 are sold at the shop after the count started, before P1 is counted.
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }],
  });
  expect(await onHand(s, p1Lot, shopHolder)).toBe(4);

  await countAll(s, countId, { P1: 4, P2: 3 });
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });

  const p1 = await lineOf(s, countId, "P1");
  expect(p1).toMatchObject({ expectedQty: 6, movedSinceSnapshot: -2, countedQty: 4, difference: 0 });

  // Everything matches: no approval, the count is done straight away.
  expect(await s.as(s.manager).mutation(api.stockCounts.submit, { countId })).toEqual({ differences: 0 });
  expect(await adjustmentsOf(s, countId)).toEqual([]);
  const count = (await s.as(s.chief).query(api.stockCounts.get, { countId }))!;
  expect(count).toMatchObject({ status: "done", diffCount: 0, lostCost: 0, gainedCost: 0 });
  expect(count.completedAt).toBeTypeOf("number");
});

test("differences change stock only after someone else approves, one approval per line", async () => {
  const { s, p1Lot, p2Lot, shopHolder } = await withShopStock();
  const countId = await startAtShop(s);
  // P1: 2 missing ($4.00 at cost); P2: 1 extra ($10.00).
  await countAll(s, countId, { P1: 4, P2: 4 });
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });

  const review = (await s.as(s.manager).query(api.stockCounts.get, { countId }))!;
  expect(review.totals).toEqual({ diffCount: 2, lostCost: 400, gainedCost: 1000 });
  expect(review.lines.map((l) => [l.productName, l.difference, l.differenceCost])).toEqual([
    ["P1", -2, -400],
    ["P2", 1, 1000],
  ]);

  // Every difference needs a reason.
  const missing = await s
    .as(s.manager)
    .mutation(api.stockCounts.submit, { countId })
    .then(() => null, (e) => e);
  expect(missing.data).toMatchObject({ code: "MISSING_REASONS" });
  expect(missing.data.itemIds).toHaveLength(2);

  const p1 = await lineOf(s, countId, "P1");
  const p2 = await lineOf(s, countId, "P2");
  await s.as(s.manager).mutation(api.stockCounts.setReason, { itemId: p1._id, reason: "damaged", note: "Water leak" });
  await s.as(s.manager).mutation(api.stockCounts.setReason, { itemId: p2._id, reason: "miscounted" });
  expect(await s.as(s.manager).mutation(api.stockCounts.submit, { countId })).toEqual({ differences: 2 });

  // Requested, not applied: stock and the product summary are unchanged.
  expect(await onHand(s, p1Lot, shopHolder)).toBe(6);
  expect(await onHand(s, p2Lot, shopHolder)).toBe(3);
  expect((await productStockOf(s, s.p1))!.onHand).toBe(10);

  const adjustments = await adjustmentsOf(s, countId);
  expect(adjustments.map((a) => [a.qty, a.cost, a.reason, a.status])).toEqual([
    [-2, 400, "damaged", "pending"],
    [1, 1000, "miscounted", "pending"],
  ]);
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", adjustments[0].approvalId!));
  expect(approval).toMatchObject({
    type: "stock_adjustment",
    requiredPermission: "stock.count.approve",
    locationId: s.shop,
    reason: "Water leak",
    payload: { after: { number: "CNT-00001", holder: "Goma Shop", product: "P1", expected: 6, counted: 4, difference: -2, countReason: "damaged", differenceCost: 400, currency: "USD" } },
  });

  // The manager (counter and requester) can't decide; the Chief Admin can.
  await expect(
    s.as(s.manager).mutation(api.approvals.decideApproval, { approvalId: adjustments[0].approvalId!, decision: "approve" }),
  ).rejects.toThrow(/stock\.count\.approve/);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: adjustments[0].approvalId!, decision: "approve" });
  expect(await onHand(s, p1Lot, shopHolder)).toBe(4);
  expect((await productStockOf(s, s.p1))!.onHand).toBe(8);
  expect((await productStockOf(s, s.p1))!.sold).toBe(0);
  expect((await s.as(s.chief).query(api.stockCounts.get, { countId }))!.status).toBe("submitted");

  // A rejected line leaves stock as it was; with nothing pending the count is done.
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: adjustments[1].approvalId!, decision: "reject" });
  expect(await onHand(s, p2Lot, shopHolder)).toBe(3);
  expect((await adjustmentsOf(s, countId)).map((a) => a.status)).toEqual(["approved", "rejected"]);
  const done = (await s.as(s.chief).query(api.stockCounts.get, { countId }))!;
  expect(done).toMatchObject({ status: "done", diffCount: 2, lostCost: 400, gainedCost: 1000 });
  expect(done.lines.map((l) => l.adjustmentStatus)).toEqual(["approved", "rejected"]);

  const movement = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_refTable_and_refId", (q) => q.eq("refTable", "stockAdjustments").eq("refId", adjustments[0]._id)).collect(),
  );
  expect(movement.map((m) => [m.type, m.qty, m.fromHolderId, m.toHolderId])).toEqual([["adjustment", 2, shopHolder, undefined]]);
});

test("the person who counted a line can't approve it, even if they hold the approval right", async () => {
  const { s, p1Lot, shopHolder } = await withShopStock();
  const counter = await insertUserWithRole(s.t, "chief_admin", { email: "chief2@x.com", name: "Chief 2" });
  // Chief Admins approve; give this one counting rights too.
  await s.t.run(async (ctx) => {
    const role = (await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", "chief_admin")).unique())!;
    for (const key of ["stock.count.record", "stock.count.review"]) {
      const permission = (await ctx.db.query("permissions").withIndex("by_key", (q) => q.eq("key", key)).unique())!;
      await ctx.db.insert("rolePermissions", { roleId: role._id, permissionId: permission._id, scope: "all_locations" });
    }
  });
  const countId = await startAtShop(s, s.manager);
  await countAll(s, countId, { P1: 5, P2: 3 }, counter);
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });
  const p1 = await lineOf(s, countId, "P1");
  await s.as(s.manager).mutation(api.stockCounts.setReason, { itemId: p1._id, reason: "unknown" });
  await s.as(s.manager).mutation(api.stockCounts.submit, { countId });
  const [adjustment] = await adjustmentsOf(s, countId);
  expect(adjustment.countedBy).toBe(counter);

  await expect(
    s.as(counter).mutation(api.approvals.decideApproval, { approvalId: adjustment.approvalId!, decision: "approve" }),
  ).rejects.toThrow(/someone else must approve/);
  expect(await onHand(s, p1Lot, shopHolder)).toBe(6);

  // Another approver can.
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: adjustment.approvalId!, decision: "approve" });
  expect(await onHand(s, p1Lot, shopHolder)).toBe(5);
});

test("the Super Admin can approve a line they counted, flagged in the audit", async () => {
  const { s, p1Lot, shopHolder } = await withShopStock();
  const countId = await startAtShop(s, s.superAdmin);
  await countAll(s, countId, { P1: 7, P2: 3 }, s.superAdmin);
  await s.as(s.superAdmin).mutation(api.stockCounts.finishCounting, { countId });
  const p1 = await lineOf(s, countId, "P1");
  await s.as(s.superAdmin).mutation(api.stockCounts.setReason, { itemId: p1._id, reason: "miscounted" });
  await s.as(s.superAdmin).mutation(api.stockCounts.submit, { countId });
  const [adjustment] = await adjustmentsOf(s, countId);
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId: adjustment.approvalId!, decision: "approve" });
  // Extra units join the holder's newest lot of the product.
  expect(await onHand(s, p1Lot, shopHolder)).toBe(7);
  const audit = await s.t.run((ctx) =>
    ctx.db.query("auditLogs").filter((q) => q.eq(q.field("entityId"), adjustment._id)).collect(),
  );
  expect(audit.find((e) => e.after?.status === "approved")!.after).toMatchObject({ selfApproved: true });
});

test("an approval that would take stock below zero stays pending", async () => {
  const { s, p1Lot, shopHolder } = await withShopStock();
  const countId = await startAtShop(s);
  await countAll(s, countId, { P1: 2, P2: 3 });
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });
  const p1 = await lineOf(s, countId, "P1");
  await s.as(s.manager).mutation(api.stockCounts.setReason, { itemId: p1._id, reason: "unrecorded_sale" });
  await s.as(s.manager).mutation(api.stockCounts.submit, { countId });

  // The shop sells 5 of its 6 meanwhile: taking 4 more would go below zero.
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "cash",
    lines: [{ inventoryBatchId: p1Lot, qty: 5, unitPrice: 500 }],
  });
  const [adjustment] = await adjustmentsOf(s, countId);
  await expect(
    s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: adjustment.approvalId!, decision: "approve" }),
  ).rejects.toThrow(/below zero/);
  expect(await onHand(s, p1Lot, shopHolder)).toBe(1);
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", adjustment.approvalId!));
  expect(approval!.status).toBe("pending");
});

test("recount, cancel, category and sample scopes", async () => {
  const { s } = await withShopStock();
  const countId = await startAtShop(s);
  await countAll(s, countId, { P1: 1 });
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });
  const p1 = await lineOf(s, countId, "P1");
  await s.as(s.manager).mutation(api.stockCounts.recount, { itemId: p1._id });
  expect(await lineOf(s, countId, "P1")).toMatchObject({ countedQty: null, reason: null });
  await s.as(s.manager).mutation(api.stockCounts.saveCount, { itemId: p1._id, countedQty: 6 });
  expect((await lineOf(s, countId, "P1")).difference).toBe(0);
  await s.as(s.manager).mutation(api.stockCounts.cancel, { countId });
  expect((await s.as(s.chief).query(api.stockCounts.get, { countId }))!.status).toBe("cancelled");
  await expect(s.as(s.manager).mutation(api.stockCounts.submit, { countId })).rejects.toThrow(/not being reviewed/);

  // A cancelled count doesn't block a new one; a sample picks N products.
  const sample = await s.as(s.manager).mutation(api.stockCounts.start, {
    businessUnitKey: "hair",
    holder: { type: "location", id: s.shop },
    scope: { kind: "sample", size: 1 },
  });
  expect((await s.as(s.chief).query(api.stockCounts.get, { countId: sample }))!.itemCount).toBe(1);
  await s.as(s.manager).mutation(api.stockCounts.cancel, { countId: sample });
  // The business's own stock, one category: "New closure" is a closure.
  const closures = await s.as(s.manager).mutation(api.stockCounts.start, {
    businessUnitKey: "hair",
    holder: { type: "business" },
    scope: { kind: "category", category: "closures" },
  });
  const lines = (await s.as(s.chief).query(api.stockCounts.get, { countId: closures, showExpected: true }))!.lines;
  expect(lines.map((l) => [l.productName, l.expectedQty])).toEqual([["New closure", 3]]);
});

test("permissions and location scope", async () => {
  const { s } = await withShopStock();
  // A Sales Agent has no count permission by default.
  await expect(startAtShop(s, s.agent)).rejects.toThrow(/stock\.count\.record/);
  // Chief Sales Admin can see stock but not count.
  await expect(startAtShop(s, s.sales)).rejects.toThrow(/stock\.count\.record/);

  // An own_location counter counts only their own location.
  const other = await insertLocation(s.t, { name: "Other" });
  const counter = await insertUserWithRole(s.t, "sales_agent", { email: "c@x.com", locationId: s.shop });
  await s.t.run(async (ctx) => {
    const role = (await ctx.db.query("roles").withIndex("by_key", (q) => q.eq("key", "sales_agent")).unique())!;
    const permission = (await ctx.db.query("permissions").withIndex("by_key", (q) => q.eq("key", "stock.count.record")).unique())!;
    await ctx.db.insert("rolePermissions", { roleId: role._id, permissionId: permission._id, scope: "own_location" });
  });
  await expect(
    s.as(counter).mutation(api.stockCounts.start, { businessUnitKey: "hair", holder: { type: "location", id: other }, scope: { kind: "all" } }),
  ).rejects.toThrow();
  await expect(
    s.as(counter).mutation(api.stockCounts.start, { businessUnitKey: "hair", holder: { type: "business" }, scope: { kind: "all" } }),
  ).rejects.toThrow();
  const countId = await startAtShop(s, counter);
  // Counting without review rights: can't submit.
  await countAll(s, countId, { P1: 6 }, counter);
  await s.as(counter).mutation(api.stockCounts.finishCounting, { countId });
  await expect(s.as(counter).mutation(api.stockCounts.submit, { countId })).rejects.toThrow(/stock\.count\.review/);

  // Only approvers set the reminder.
  await expect(s.as(s.manager).mutation(api.stockCounts.setSettings, { businessUnitKey: "hair", reminderDays: 14 })).rejects.toThrow();
  await s.as(s.chief).mutation(api.stockCounts.setSettings, { businessUnitKey: "hair", reminderDays: 14 });
  expect(await s.as(s.manager).query(api.stockCounts.settings, { businessUnitKey: "hair" })).toEqual({ reminderDays: 14 });
});

test("Home knows the last finished count and the reminder limit", async () => {
  const { s } = await withShopStock();
  expect((await s.as(s.manager).query(api.home.summary, { businessUnitKey: "hair" })).stockCount).toEqual({
    lastCountDay: null,
    reminderDays: 30,
  });
  // No count permission: no reminder.
  expect((await s.as(s.agent).query(api.home.summary, { businessUnitKey: "hair" })).stockCount).toBeNull();

  const countId = await startAtShop(s);
  await countAll(s, countId, { P1: 6, P2: 3 });
  await s.as(s.manager).mutation(api.stockCounts.finishCounting, { countId });
  await s.as(s.manager).mutation(api.stockCounts.submit, { countId });
  const summary = await s.as(s.manager).query(api.home.summary, { businessUnitKey: "hair" });
  expect(summary.stockCount).toEqual({ lastCountDay: summary.today, reminderDays: 30 });
});
