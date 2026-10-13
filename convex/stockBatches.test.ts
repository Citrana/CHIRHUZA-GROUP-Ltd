import { expect, test } from "vitest";
import { api } from "./_generated/api";
import { MAX_RECEIPT_BYTES, receiptProblem } from "./lib/stockBatches";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import {
  PAGE,
  arrivedMixedBatch,
  batchItemFor,
  buildMixedBatch,
  getBatch,
  getLine,
  getRequisition,
  receiveAll,
  setupStock,
} from "./lib/stock.test.utils";
import { getRoleId, insertLocation, insertUserWithRole } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const setup = () => setupStock(modules);

test("the full mixed flow: resolutions, totals, requisitions", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);

  const batch = await getBatch(s, b.batchId);
  expect(batch).toMatchObject({
    number: "BATCH-00001",
    status: "purchased",
    currency: "USD",
    // Purchased value: 10×2.00 + 3×10.00 + 3×5.00 = $65.00. L3 excluded.
    purchasedTotal: 6500,
  });

  // Expenses never change what the products cost.
  const items = await s.t.run((ctx) =>
    ctx.db.query("stockBatchItems").withIndex("by_batchId", (q) => q.eq("batchId", b.batchId)).collect(),
  );
  const byId = new Map(items.map((i) => [i._id, i]));
  expect(byId.get(b.i1._id)).toMatchObject({ unitCost: 200, qtyPurchased: 10 });
  expect(byId.get(b.i2._id)).toMatchObject({ unitCost: 1000, qtyPurchased: 3 });
  expect(byId.get(b.extraId)).toMatchObject({ unitCost: 500, qtyPurchased: 3, qtyRequested: 0 });
  for (const item of items) {
    expect(Object.keys(item).filter((k) => /cost/i.test(k))).toEqual(item.unitCost === undefined ? [] : ["unitCost"]);
  }
  // Not purchased: no cost, excluded from all money.
  expect(byId.get(b.i3._id)).toMatchObject({ status: "not_purchased", qtyPurchased: 0 });
  expect(byId.get(b.i3._id)!.unitCost).toBeUndefined();

  // Requisition lines resolved; A closes, B still has L4 open.
  expect((await getLine(s, b.l1))!.resolution).toBe("purchased");
  expect((await getLine(s, b.l2))!.resolution).toBe("partial");
  expect((await getLine(s, b.l3))!.resolution).toBe("not_purchased");
  expect((await getLine(s, b.l4))!.resolution).toBe("pending");
  expect((await getRequisition(s, b.reqA.requisitionId))!.status).toBe("closed");
  // B keeps a line (L3) in this batch, and L4 is still open: purchasing.
  expect((await getRequisition(s, b.reqB.requisitionId))!.status).toBe("purchasing");

  // The extra product was created pending confirmation.
  const extra = await s.t.run((ctx) => ctx.db.get("products", b.extraProduct));
  expect(extra!.status).toBe("pending_confirmation");

  // Goma view data: purchased vs not purchased, receipts, requisitions.
  const detail = await s.as(s.manager).query(api.stockBatches.get, { batchId: b.batchId });
  expect(detail!.items.filter((i) => i.status === "not_purchased").map((i) => i.reason)).toEqual(["Discontinued"]);
  expect(detail!.expenses.find((e) => e.category === "freight")!.receiptUrl).toBeTruthy();
  expect(detail!.requisitions).toHaveLength(2);
  // Expenses stay aside: freight $8.00 + meals $3.00.
  expect(detail!.totals).toEqual({ purchasedTotal: 6500, expensesTotal: 1100, grandTotal: 7600 });

  // Locked after purchase.
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.updateItem, {
      itemId: b.i1._id,
      status: "purchased",
      qtyPurchased: 11,
      unitCost: 200,
    }),
  ).rejects.toThrow(/locked/);
});

test("approval, then shipped / arrived / received with the right people", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);
  const approvalId = await s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId: b.batchId });

  await expect(
    s.as(s.inventory).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" }),
  ).rejects.toThrow(/stock\.approve/);
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.markShipped, { batchId: b.batchId }),
  ).rejects.toThrow(/Only a approved batch/);

  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  expect((await getBatch(s, b.batchId))!.status).toBe("approved");

  // Only its buyer ships it; Goma records arrival and receipt.
  await expect(
    s.as(s.manager).mutation(api.stockBatches.markShipped, { batchId: b.batchId }),
  ).rejects.toThrow(/stock\.create/);
  await s.as(s.inventory).mutation(api.stockBatches.markShipped, { batchId: b.batchId });
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.markArrived, { batchId: b.batchId }),
  ).rejects.toThrow(/stock\.receive/);
  await s.as(s.manager).mutation(api.stockBatches.markArrived, { batchId: b.batchId });
  // The Chief Sales Admin receives it (counting what arrived).
  await receiveAll(s, b.batchId, s.sales);

  const batch = await getBatch(s, b.batchId);
  expect(batch).toMatchObject({ status: "received" });
  for (const stamp of ["purchasedAt", "approvedAt", "shippedAt", "arrivedAt", "receivedAt"] as const) {
    expect(batch![stamp]).toBeTypeOf("number");
  }
});

test("receiving: Goma counts purchased lines; good units become lots at the business", async () => {
  const s = await setup();
  const b = await arrivedMixedBatch(s);
  const count = (who: typeof s.manager, itemId: typeof b.i1._id, qtyReceived: number, qtyDamaged = 0, reason?: string) =>
    s.as(who).mutation(api.stockBatches.setReceiveCount, {
      itemId,
      qtyReceived,
      qtyDamaged,
      ...(reason ? { reason } : {}),
    });

  // Needs stock.receive (the buyer and the chief don't have it).
  await expect(count(s.inventory, b.i1._id, 10)).rejects.toThrow(/stock\.receive/);
  await expect(count(s.chief, b.i1._id, 10)).rejects.toThrow(/stock\.receive/);
  // Only purchased lines; never more than purchased; whole numbers.
  await expect(count(s.manager, b.i3._id, 1)).rejects.toThrow(/Only purchased lines/);
  await expect(count(s.manager, b.i1._id, 9, 2)).rejects.toThrow(/can't exceed the 10 purchased/);
  await expect(count(s.manager, b.i1._id, 1.5)).rejects.toThrow(/whole number/);

  // L1: 8 good + 1 damaged (1 missing); L2: all 3; the extra: not counted yet.
  await count(s.manager, b.i1._id, 8, 1);
  await count(s.sales, b.i2._id, 3);
  const incomplete = await s
    .as(s.manager)
    .mutation(api.stockBatches.confirmReceipt, { batchId: b.batchId })
    .then(() => null, (e) => e);
  expect(incomplete.data).toMatchObject({ code: "INCOMPLETE" });
  const problems = Object.fromEntries(
    (incomplete.data.lines as Array<{ itemId: string; problems: string[] }>).map((l) => [l.itemId, l.problems]),
  );
  expect(problems).toEqual({ [b.i1._id]: ["reason"], [b.extraId]: ["count"] });

  await count(s.manager, b.i1._id, 8, 1, "One torn in transit, one missing from the box");
  await count(s.manager, b.extraId, 3);
  const detail = await s.as(s.manager).query(api.stockBatches.get, { batchId: b.batchId });
  expect(detail!.canReceive).toBe(true);
  expect(detail!.items.find((i) => i._id === b.i1._id)).toMatchObject({ missing: 1, receiveProblems: [] });

  await s.as(s.manager).mutation(api.stockBatches.confirmReceipt, { batchId: b.batchId });
  const batch = await getBatch(s, b.batchId);
  expect(batch).toMatchObject({ status: "received", receivedBy: s.manager });

  // Lots: good units only, at the purchase unit cost; nothing for L3.
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const bySource = new Map(lots.map((l) => [l.sourceStockBatchItemId, l]));
  expect(lots).toHaveLength(3);
  expect(bySource.get(b.i1._id)).toMatchObject({ receivedQty: 8, unitCost: 200, currency: "USD" });
  expect(bySource.get(b.i2._id)).toMatchObject({ receivedQty: 3, unitCost: 1000 });
  expect(bySource.get(b.extraId)).toMatchObject({ receivedQty: 3, unitCost: 500 });

  // All of it sits with the business, through "receive" movements.
  const overview = await s.as(s.chief).query(api.inventory.overview, { businessUnitKey: "hair" });
  expect(overview.byHolder.map((h) => [h.holder.type, h.qty])).toEqual([["business", 14]]);
  const movements = await s.t.run((ctx) => ctx.db.query("inventoryMovements").collect());
  expect(movements.map((m) => [m.type, m.qty, m.fromHolderId ?? null])).toEqual([
    ["receive", 8, null],
    ["receive", 3, null],
    ["receive", 3, null],
  ]);

  // Once only; counts are locked afterwards.
  await expect(
    s.as(s.manager).mutation(api.stockBatches.confirmReceipt, { batchId: b.batchId }),
  ).rejects.toThrow(/Only an arrived batch/);
  await expect(count(s.manager, b.i1._id, 10)).rejects.toThrow(/Only an arrived batch/);
});

test("a batch can't be counted or received before it arrives", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);
  await expect(
    s.as(s.manager).mutation(api.stockBatches.setReceiveCount, { itemId: b.i1._id, qtyReceived: 10, qtyDamaged: 0 }),
  ).rejects.toThrow(/Only an arrived batch/);
  await expect(
    s.as(s.manager).mutation(api.stockBatches.confirmReceipt, { batchId: b.batchId }),
  ).rejects.toThrow(/Only an arrived batch/);
});

test("expenses stay open after purchase: the buyer and the Goma team add them along the way", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);
  const totals = async () => (await s.as(s.manager).query(api.stockBatches.get, { batchId: b.batchId }))!.totals;
  const unitCosts = () =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("stockBatchItems").withIndex("by_batchId", (q) => q.eq("batchId", b.batchId)).collect()).map(
        (i) => i.unitCost ?? null,
      ),
    );
  const costsBefore = await unitCosts();

  // Purchased: the buyer adds one; the goods total stays fixed.
  await s.as(s.inventory).mutation(api.stockBatches.addExpense, { batchId: b.batchId, category: "transport", amount: 2000 });
  expect(await totals()).toEqual({ purchasedTotal: 6500, expensesTotal: 3100, grandTotal: 9600 });
  expect(await unitCosts()).toEqual(costsBefore);
  // Lines stay locked.
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.updateItem, { itemId: b.i1._id, status: "purchased", qtyPurchased: 1, unitCost: 1 }),
  ).rejects.toThrow(/locked/);

  const approvalId = await s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId: b.batchId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  await s.as(s.inventory).mutation(api.stockBatches.markShipped, { batchId: b.batchId });

  // Shipped: the Goma manager pays freight on arrival, fixes it, removes it.
  const freight = await s.as(s.manager).mutation(api.stockBatches.addExpense, {
    batchId: b.batchId,
    category: "freight",
    amount: 15_000,
    note: "Sea freight to Goma",
  });
  await s.as(s.manager).mutation(api.stockBatches.updateExpense, {
    expenseId: freight,
    category: "freight",
    amount: 14_000,
  });
  expect((await totals()).expensesTotal).toBe(17_100);
  await s.as(s.manager).mutation(api.stockBatches.removeExpense, { expenseId: freight });
  expect((await totals()).expensesTotal).toBe(3100);

  // Even after it's received, for late invoices (the chief holds stock.approve).
  await s.as(s.manager).mutation(api.stockBatches.markArrived, { batchId: b.batchId });
  await receiveAll(s, b.batchId);
  await s.as(s.chief).mutation(api.stockBatches.addExpense, { batchId: b.batchId, category: "customs", amount: 900 });
  expect(await totals()).toEqual({ purchasedTotal: 6500, expensesTotal: 4000, grandTotal: 10_500 });
  expect(await unitCosts()).toEqual(costsBefore);

  // Audited with the batch's status at the time.
  const customs = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find(
      (a) => a.entityTable === "stockBatchExpenses" && a.action === "create" && (a.after as { category?: string })?.category === "customs",
    ),
  );
  expect(customs!.after).toMatchObject({ batch: "BATCH-00001", amount: 900, currency: "USD", batchStatus: "received" });

  // Someone without stock access can't.
  await expect(
    s.as(s.agent).mutation(api.stockBatches.addExpense, { batchId: b.batchId, category: "other", amount: 100 }),
  ).rejects.toThrow(/stock\.view/);
});

test("in a draft, only the buyer (or the Super Admin) changes expenses", async () => {
  const s = await setup();
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Draft" });
  await expect(
    s.as(s.manager).mutation(api.stockBatches.addExpense, { batchId, category: "meals", amount: 100 }),
  ).rejects.toThrow(/can't change this batch's expenses/);
  await expect(s.as(s.manager).mutation(api.stockBatches.generateReceiptUploadUrl, { batchId })).rejects.toThrow(
    /can't change this batch's expenses/,
  );
  expect((await s.as(s.manager).query(api.stockBatches.get, { batchId }))!.canEditExpenses).toBe(false);
  expect((await s.as(s.inventory).query(api.stockBatches.get, { batchId }))!.canEditExpenses).toBe(true);
  await s.as(s.superAdmin).mutation(api.stockBatches.addExpense, { batchId, category: "meals", amount: 100 });
});

test("a rejected approval sends the batch back to draft and reverts everything", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);
  const approvalId = await s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId: b.batchId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "reject", note: "Check costs" });

  const batch = await getBatch(s, b.batchId);
  expect(batch).toMatchObject({ status: "draft" });
  expect(batch!.purchasedTotal).toBeUndefined();
  expect((await getLine(s, b.l1))!.resolution).toBe("pending");
  expect((await getRequisition(s, b.reqA.requisitionId))!.status).toBe("purchasing");

  // Editable again, and can be re-purchased.
  await s.as(s.inventory).mutation(api.stockBatches.updateItem, {
    itemId: b.i1._id,
    status: "purchased",
    qtyPurchased: 10,
    unitCost: 190,
  });
  await s.as(s.inventory).mutation(api.stockBatches.markPurchased, { batchId: b.batchId });
  expect((await getBatch(s, b.batchId))!.status).toBe("purchased");
});

test("a reopen request, once approved, unlocks the batch; a rejected one keeps it locked", async () => {
  const s = await setup();
  const b = await buildMixedBatch(s);
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.requestReopen, { batchId: b.batchId, reason: "  " }),
  ).rejects.toThrow(/reason/);

  const first = await s.as(s.inventory).mutation(api.stockBatches.requestReopen, { batchId: b.batchId, reason: "Wrong cost" });
  // Only one request at a time.
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId: b.batchId }),
  ).rejects.toThrow(/already waiting/);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: first, decision: "reject" });
  expect((await getBatch(s, b.batchId))!.status).toBe("purchased");

  const second = await s.as(s.inventory).mutation(api.stockBatches.requestReopen, { batchId: b.batchId, reason: "Wrong cost" });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: second, decision: "approve" });
  expect((await getBatch(s, b.batchId))!.status).toBe("draft");
  expect((await getLine(s, b.l2))!.resolution).toBe("pending");
});

test("the builder offers only approved requisitions' free pending lines; a line is in one batch", async () => {
  const s = await setup();
  const reqA = await s.approvedRequisition([[s.p1, 1], [s.p2, 2]]);
  // A draft requisition isn't offered.
  const draftReq = await s.as(s.sales).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.shop });
  await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId: draftReq, productId: s.p3, qtyRequested: 1 });

  const options = async () =>
    (await s.as(s.inventory).query(api.stockBatches.requisitionOptions, { businessUnitKey: "hair" })).map((r) => [
      r._id,
      r.lines.map((l) => l._id),
    ]);
  expect(await options()).toEqual([[reqA.requisitionId, reqA.lineIds]]);

  const batch1 = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "One" });
  const batch2 = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Two" });
  await s.as(s.inventory).mutation(api.stockBatches.addRequisitionLines, { batchId: batch1, requisitionItemIds: [reqA.lineIds[0]] });
  expect(await options()).toEqual([[reqA.requisitionId, [reqA.lineIds[1]]]]);
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.addRequisitionLines, { batchId: batch2, requisitionItemIds: [reqA.lineIds[0]] }),
  ).rejects.toThrow(/already in a batch/);
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.addRequisitionLines, {
      batchId: batch2,
      requisitionItemIds: [
        (await s.t.run((ctx) =>
          ctx.db.query("requisitionItems").withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", draftReq)).first(),
        ))!._id,
      ],
    }),
  ).rejects.toThrow(/approved requisitions/);

  // Removing the line frees it again and unlinks the requisition.
  const item = await batchItemFor(s, reqA.lineIds[0]);
  await s.as(s.inventory).mutation(api.stockBatches.removeItem, { itemId: item._id });
  expect(await options()).toEqual([[reqA.requisitionId, reqA.lineIds]]);
  expect((await getRequisition(s, reqA.requisitionId))!.status).toBe("approved");
  const links = await s.t.run((ctx) => ctx.db.query("stockBatchRequisitions").collect());
  expect(links).toHaveLength(0);
});

test("receipt rule: images or PDFs up to 10 MB", () => {
  expect(receiptProblem({ contentType: "application/pdf", size: 1000 })).toBeNull();
  expect(receiptProblem({ contentType: "image/jpeg", size: MAX_RECEIPT_BYTES })).toBeNull();
  expect(receiptProblem({ contentType: "text/plain", size: 10 })).toBe("type");
  expect(receiptProblem({ contentType: "image/png", size: MAX_RECEIPT_BYTES + 1 })).toBe("size");
  // Browser uploads always send a type; unknown isn't rejected.
  expect(receiptProblem({ size: 10 })).toBeNull();
});

test("expenses are USD cents; removing one removes its receipt file", async () => {
  const s = await setup();
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "T" });
  for (const amount of [0, 12.5, -5]) {
    await expect(
      s.as(s.inventory).mutation(api.stockBatches.addExpense, { batchId, category: "other", amount }),
    ).rejects.toThrow(/cents/);
  }
  const photo = await s.t.run((ctx) => ctx.storage.store(new Blob(["jpg"], { type: "image/jpeg" })));
  const expenseId = await s.as(s.inventory).mutation(api.stockBatches.addExpense, {
    batchId,
    category: "customs",
    amount: 12_345,
    receiptFileId: photo,
  });
  // Removing the expense also removes its receipt file.
  await s.as(s.inventory).mutation(api.stockBatches.removeExpense, { expenseId });
  expect(await s.t.run((ctx) => ctx.db.system.get("_storage", photo))).toBeNull();
});

test("setting unit costs needs stock.set_price; seeing batches needs stock.view", async () => {
  const s = await setup();
  // A buyer who can create batches but not set prices.
  const noPriceRole = await getRoleId(s.t, "manager_admin");
  await s.t.run(async (ctx) => {
    const create = await ctx.db.query("permissions").withIndex("by_key", (q) => q.eq("key", "stock.create")).unique();
    await ctx.db.insert("rolePermissions", { roleId: noPriceRole, permissionId: create!._id, scope: "all_locations" });
  });
  const batchId = await s.as(s.manager).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "T" });
  await expect(
    s.as(s.manager).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 1, unitCost: 100 }),
  ).rejects.toThrow(/stock\.set_price/);
  const itemId = await s.as(s.manager).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 1 });
  await expect(
    s.as(s.manager).mutation(api.stockBatches.updateItem, { itemId, status: "purchased", qtyPurchased: 2, unitCost: 100 }),
  ).rejects.toThrow(/stock\.set_price/);
  await s.as(s.manager).mutation(api.stockBatches.updateItem, { itemId, status: "purchased", qtyPurchased: 2, unitCost: null });

  await expect(
    s.as(s.agent).query(api.stockBatches.list, { businessUnitKey: "hair", paginationOpts: PAGE }),
  ).rejects.toThrow(/stock\.view/);
  expect(
    (await s.as(s.chief).query(api.stockBatches.list, { businessUnitKey: "hair", paginationOpts: PAGE })).page,
  ).toHaveLength(1);
});

test("only the buyer (or the Super Admin) edits a batch; the Super Admin can do everything", async () => {
  const s = await setup();
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Buyer's" });
  await expect(
    s.as(s.chief).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 1 }),
  ).rejects.toThrow(/stock\.create/);
  // The Super Admin edits the buyer's draft...
  await s.as(s.superAdmin).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 2, unitCost: 100 });

  // ...and runs a batch of their own end to end, approving it themselves.
  const own = await s.as(s.superAdmin).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Own" });
  await s.as(s.superAdmin).mutation(api.stockBatches.addExtraItem, { batchId: own, productId: s.p2, qtyPurchased: 1, unitCost: 1000 });
  await s.as(s.superAdmin).mutation(api.stockBatches.markPurchased, { batchId: own });
  const approvalId = await s.as(s.superAdmin).mutation(api.stockBatches.submitForApproval, { batchId: own });
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  await s.as(s.superAdmin).mutation(api.stockBatches.markShipped, { batchId: own });
  await s.as(s.superAdmin).mutation(api.stockBatches.markArrived, { batchId: own });
  await receiveAll(s, own, s.superAdmin);
  expect((await getBatch(s, own))!.status).toBe("received");

  const decision = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find(
      (a) => a.entityTable === "approvals" && a.entityId === approvalId && a.action === "approve",
    ),
  );
  expect(decision!.after).toMatchObject({ selfApproved: true });
});

test("a product in a batch can only be archived, not deleted; every step is audited", async () => {
  const s = await setup();
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "T" });
  await s.as(s.inventory).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p4, qtyPurchased: 1 });
  await expect(
    s.as(s.chief).mutation(api.products.requestDeletion, { productId: s.p4, reason: "Old" }),
  ).rejects.toThrow(/Archive it instead/);

  const audited = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect())
      .filter((a) => a.entityTable.startsWith("stockBatch"))
      .map((a) => `${a.entityTable}:${a.action}`),
  );
  expect(audited).toEqual(["stockBatches:create", "stockBatchItems:create"]);
});

test("an empty requisition (with a note) is filled in by the buyer while purchasing", async () => {
  const s = await setup();
  // The shop submits an empty requisition: a note is required.
  const requisitionId = await s.as(s.sales).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.shop });
  await expect(s.as(s.sales).mutation(api.requisitions.submit, { requisitionId })).rejects.toThrow(/in the note/);
  await s.as(s.sales).mutation(api.requisitions.update, {
    requisitionId,
    locationId: s.shop,
    note: "New stock for the shop, about $500",
  });
  const approvalId = await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });

  // The buyer sees it as open, and can target it.
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Trip" });
  const options = await s.as(s.inventory).query(api.stockBatches.requisitionOptions, { businessUnitKey: "hair" });
  expect(options.find((r) => r._id === requisitionId)).toMatchObject({ isOpen: true, lines: [], note: "New stock for the shop, about $500" });
  const targets = await s.as(s.inventory).query(api.stockBatches.targetRequisitions, { businessUnitKey: "hair" });
  expect(targets.map((r) => [r._id, r.lineCount])).toContainEqual([requisitionId, 0]);

  // An existing product and a new one (pending confirmation) for that requisition.
  const p1Item = await s.as(s.inventory).mutation(api.stockBatches.addExtraItem, {
    batchId,
    productId: s.p1,
    qtyPurchased: 4,
    unitCost: 300,
    requisitionId,
  });
  const newProduct = await s.as(s.inventory).mutation(api.products.create, {
    businessUnitKey: "hair",
    name: "New frontal",
    category: "frontals",
    unit: "piece",
  });
  await s.as(s.inventory).mutation(api.stockBatches.addExtraItem, {
    batchId,
    productId: newProduct,
    qtyPurchased: 2,
    unitCost: 900,
    requisitionId,
  });
  const lines = await s.t.run((ctx) =>
    ctx.db
      .query("requisitionItems")
      .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisitionId))
      .collect(),
  );
  expect(lines.map((l) => [l.qtyRequested, l.addedByBuyer, l.resolution]).sort()).toEqual([
    [2, true, "pending"],
    [4, true, "pending"],
  ]);
  expect((await getRequisition(s, requisitionId))!.status).toBe("purchasing");
  // The same product can't be added twice to that requisition.
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 1, requisitionId }),
  ).rejects.toThrow(/already requested/);

  // Removing a buyer-added line removes it from the requisition too.
  const p2Item = await s.as(s.inventory).mutation(api.stockBatches.addExtraItem, {
    batchId,
    productId: s.p2,
    qtyPurchased: 1,
    requisitionId,
  });
  await s.as(s.inventory).mutation(api.stockBatches.removeItem, { itemId: p2Item });
  const afterRemove = await s.t.run((ctx) =>
    ctx.db
      .query("requisitionItems")
      .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisitionId))
      .collect(),
  );
  expect(afterRemove).toHaveLength(2);

  // Purchased: the buyer-added lines resolve and the requisition closes.
  await s.as(s.inventory).mutation(api.stockBatches.markPurchased, { batchId });
  const detail = await s.as(s.sales).query(api.requisitions.get, { requisitionId });
  expect(detail!.status).toBe("closed");
  expect(detail!.items.map((i) => [i.addedByBuyer, i.resolution])).toEqual([
    [true, "purchased"],
    [true, "purchased"],
  ]);
  const batchItem = await s.t.run((ctx) => ctx.db.get("stockBatchItems", p1Item));
  expect(batchItem).toMatchObject({ qtyRequested: 4, qtyPurchased: 4 });
});

test("the buyer can add to a requisition with lines; only approved requisitions take products", async () => {
  const s = await setup();
  const { requisitionId, lineIds } = await s.approvedRequisition([[s.p1, 5]]);
  const batchId = await s.as(s.inventory).mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Trip" });
  await s.as(s.inventory).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p3, qtyPurchased: 2, requisitionId });
  const lines = await s.t.run((ctx) =>
    ctx.db
      .query("requisitionItems")
      .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisitionId))
      .collect(),
  );
  // The original line is untouched; the new one is flagged.
  expect(lines.find((l) => l._id === lineIds[0])).toMatchObject({ qtyRequested: 5, resolution: "pending" });
  expect(lines.find((l) => l.addedByBuyer)).toMatchObject({ qtyRequested: 2 });
  // Already requested on that requisition (pending): add it from the requisition instead.
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p1, qtyPurchased: 1, requisitionId }),
  ).rejects.toThrow(/already requested/);

  // A draft requisition can't receive products.
  const draftId = await s.as(s.sales).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.shop });
  await expect(
    s.as(s.inventory).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p2, qtyPurchased: 1, requisitionId: draftId }),
  ).rejects.toThrow(/Only approved requisitions/);
  // Only the batch's buyer (stock.create) adds lines.
  await expect(
    s.as(s.manager).mutation(api.stockBatches.addExtraItem, { batchId, productId: s.p2, qtyPurchased: 1, requisitionId }),
  ).rejects.toThrow(/stock\.create/);
});

test("requisitions.get shows how each line was purchased, for the PDF", async () => {
  const s = await setup();
  const reqA = await s.approvedRequisition([[s.p1, 10], [s.p2, 5]]);
  const before = await s.as(s.chief).query(api.requisitions.get, { requisitionId: reqA.requisitionId });
  expect(before!.items.map((i) => i.purchases)).toEqual([[], []]);

  const b = await buildMixedBatch(s);
  const detail = await s.as(s.chief).query(api.requisitions.get, { requisitionId: b.reqA.requisitionId });
  expect(detail!.items.map((i) => [i.productName, i.resolution, i.purchases])).toEqual([
    ["P1", "purchased", [{ batchNumber: "BATCH-00001", batchStatus: "purchased", status: "purchased", qtyPurchased: 10, reason: null }]],
    ["P2", "partial", [{ batchNumber: "BATCH-00001", batchStatus: "purchased", status: "purchased", qtyPurchased: 3, reason: "Supplier only had 3" }]],
  ]);
  const reqB = await s.as(s.chief).query(api.requisitions.get, { requisitionId: b.reqB.requisitionId });
  expect(reqB!.items.map((i) => [i.productName, i.purchases.map((p) => [p.status, p.reason])])).toEqual([
    ["P3", [["not_purchased", "Discontinued"]]],
    ["P4", []],
  ]);
});

test("sellingReport: expected at selling prices, sold so far, remaining; unpriced products listed", async () => {
  const s = await setup();
  const b = await arrivedMixedBatch(s);
  await s.as(s.sales).mutation(api.products.setSuggestedPrice, { productId: s.p1, price: 500 });
  await s.as(s.sales).mutation(api.products.setSuggestedPrice, { productId: s.p2, price: 1500 });
  const report = () => s.as(s.chief).query(api.stockBatches.sellingReport, { batchId: b.batchId });

  // Before receiving: expected is known, nothing received / sold / remaining yet.
  const before = (await report())!;
  expect(before.received).toBe(false);
  expect(before.lines.map((l) => [l.name, l.purchased, l.expected, l.sold, l.remaining])).toEqual([
    ["New closure", 3, null, null, null],
    ["P1", 10, 5000, null, null],
    ["P2", 3, 4500, null, null],
  ]);

  // Receive: 2 of P1 damaged.
  const items = await s.t.run((ctx) =>
    ctx.db.query("stockBatchItems").withIndex("by_batchId", (q) => q.eq("batchId", b.batchId)).collect(),
  );
  for (const item of items.filter((i) => i.status === "purchased")) {
    const damaged = item._id === b.i1._id ? 2 : 0;
    await s.as(s.manager).mutation(api.stockBatches.setReceiveCount, {
      itemId: item._id,
      qtyReceived: item.qtyPurchased - damaged,
      qtyDamaged: damaged,
      ...(damaged ? { reason: "Torn" } : {}),
    });
  }
  await s.as(s.manager).mutation(api.stockBatches.confirmReceipt, { batchId: b.batchId });

  // 6 of P1 go to the shop; the agent sells 2 at $5, 1 at $4 (discount), 1 at $7 (above), and one sale is voided.
  const p1Lot = (await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_sourceStockBatchItemId", (q) => q.eq("sourceStockBatchItemId", b.i1._id)).unique(),
  ))!._id;
  await s.t.run(async (ctx) => {
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    await applyMovement(ctx, {
      type: "distribute",
      inventoryBatchId: p1Lot,
      fromHolderId: business,
      toHolderId: await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop }),
      qty: 6,
      refTable: "test",
      refId: "setup",
      actorId: s.chief,
    });
  });
  const sell = (unitPrice: number, qty: number, discountReason?: string) =>
    s.as(s.agent).mutation(api.sales.create, {
      businessUnitKey: "hair",
      paymentMethod: "cash",
      lines: [{ inventoryBatchId: p1Lot, qty, unitPrice, ...(discountReason ? { discountReason } : {}) }],
    });
  await sell(500, 2);
  await sell(400, 1, "Loyal customer");
  await sell(700, 1, "Gift wrapping");
  const { saleId: voided } = await sell(500, 1);
  await s.t.run((ctx) => ctx.db.patch("sales", voided, { status: "voided" }));

  const after = (await report())!;
  expect(after.received).toBe(true);
  expect(
    after.lines.map((l) => [l.name, l.purchased, l.received, l.damagedOrMissing, l.sold, l.remaining, l.remainingValue]),
  ).toEqual([
    ["New closure", 3, 3, 0, { qty: 0, amount: 0 }, 3, null],
    // 8 received; 5 left the stock (the voided sale's piece too), only completed sales count as sold.
    ["P1", 10, 8, 2, { qty: 4, amount: 2100 }, 3, 1500],
    ["P2", 3, 3, 0, { qty: 0, amount: 0 }, 3, 4500],
  ]);
  expect(after.totals).toEqual({
    purchased: 16,
    expected: 9500,
    soldQty: 4,
    soldAmount: 2100,
    remaining: 9,
    remainingValue: 6000,
    damagedOrMissing: 2,
    // 2 damaged Bob 12" at the $5.00 selling price.
    damagedValue: 1000,
    // 4 sold x $5.00 - $21.00: $1 below on one, $2 above on another.
    priceDifference: -100,
  });
  expect(after.unpriced.map((p) => p.name)).toEqual(["New closure"]);
  const p1Line = after.lines.find((l) => l.name === "P1")!;
  expect([p1Line.damaged, p1Line.missing, p1Line.receiveReason]).toEqual([2, 0, "Torn"]);

  // Each completed sale line, with its difference from today's price and its reason.
  expect(
    after.saleLines
      .map((l) => [l.qty, l.unitPrice, l.amount, l.priceAtSale, l.todayPrice, l.difference, l.discountReason, l.locationName])
      .sort((a, b) => Number(a[1]) - Number(b[1])),
  ).toEqual([
    [1, 400, 400, 500, 500, 100, "Loyal customer", "Goma Shop"],
    [2, 500, 1000, 500, 500, 0, null, "Goma Shop"],
    [1, 700, 700, 500, 500, -200, "Gift wrapping", "Goma Shop"],
  ]);
  expect(after.saleLinesHidden).toBe(false);
  // Remaining per holder: 2 in the business stock, 1 at the shop (P1), plus the other lots' units.
  expect(after.remainingByHolder.map((h) => [h.type, h.qty])).toEqual([["business", 8], ["location", 1]]);

  // Without sales.view (the buyer): totals only, no individual sales.
  const buyerView = (await s.as(s.inventory).query(api.stockBatches.sellingReport, { batchId: b.batchId }))!;
  expect(buyerView.saleLinesHidden).toBe(true);
  expect(buyerView.saleLines).toEqual([]);
  expect(buyerView.totals).toEqual(after.totals);


  // Same permission as the batch page.
  await expect(s.as(s.agent).query(api.stockBatches.sellingReport, { batchId: b.batchId })).rejects.toThrow(/stock\.view/);

  // A sales agent (sales.view at own_location) given stock.view sees only sales at the caller's shop.
  const other = await insertLocation(s.t, { name: "Lubumbashi Shop" });
  const stockView = await s.t.run(
    async (ctx) => (await ctx.db.query("permissions").withIndex("by_key", (q) => q.eq("key", "stock.view")).unique())!._id,
  );
  const seller = await insertUserWithRole(s.t, "sales_agent", { email: "seller2@x.com", locationId: other });
  await s.t.run(async (ctx) => {
    const roleId = (await ctx.db.get("users", seller))!.roleId!;
    await ctx.db.insert("rolePermissions", { roleId, permissionId: stockView, scope: "own_location" });
  });
  const sellerView = (await s.as(seller).query(api.stockBatches.sellingReport, { batchId: b.batchId }))!;
  expect(sellerView.saleLinesHidden).toBe(false);
  expect(sellerView.saleLines).toEqual([]);
});
