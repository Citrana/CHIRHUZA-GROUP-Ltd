import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MAX_RECEIPT_BYTES, receiptProblem } from "./lib/stockBatches";
import {
  getBusinessUnitId,
  getRoleId,
  insertLocation,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const hairId = await getBusinessUnitId(t, "hair");
  const shop = await insertLocation(t, { name: "Goma Shop" });
  const sales = await insertUserWithRole(t, "chief_sales_admin", { email: "sales@x.com", name: "Sales" });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const inventory = await insertUserWithRole(t, "chief_inventory_admin", { email: "inv@x.com", name: "Buyer" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Goma" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com", name: "Super" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", locationId: shop });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });

  const product = (name: string) =>
    t.run((ctx) =>
      ctx.db.insert("products", {
        businessUnitId: hairId,
        name,
        sku: `HAIR-${name}`,
        category: "wigs",
        unit: "piece",
        status: "active",
        createdBy: chief,
        searchText: name.toLowerCase(),
      }),
    );
  const [p1, p2, p3, p4] = [await product("P1"), await product("P2"), await product("P3"), await product("P4")];

  /** An approved requisition with the given lines. Returns its line ids in order. */
  async function approvedRequisition(lines: Array<[Id<"products">, number]>) {
    const requisitionId = await as(sales).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: shop });
    const lineIds: Id<"requisitionItems">[] = [];
    for (const [productId, qtyRequested] of lines) {
      lineIds.push(await as(sales).mutation(api.requisitions.addItem, { requisitionId, productId, qtyRequested }));
    }
    const approvalId = await as(sales).mutation(api.requisitions.submit, { requisitionId });
    await as(chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
    return { requisitionId, lineIds };
  }

  return { t, hairId, shop, sales, chief, inventory, manager, superAdmin, agent, as, p1, p2, p3, p4, approvedRequisition };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const getBatch = (s: Setup, id: Id<"stockBatches">) => s.t.run((ctx) => ctx.db.get("stockBatches", id));
const getLine = (s: Setup, id: Id<"requisitionItems">) => s.t.run((ctx) => ctx.db.get("requisitionItems", id));
const getRequisition = (s: Setup, id: Id<"requisitions">) => s.t.run((ctx) => ctx.db.get("requisitions", id));

async function batchItemFor(s: Setup, lineId: Id<"requisitionItems">) {
  return (await s.t.run((ctx) =>
    ctx.db
      .query("stockBatchItems")
      .withIndex("by_requisitionItemId", (q) => q.eq("requisitionItemId", lineId))
      .unique(),
  ))!;
}

/**
 * The spec's mixed batch: requisition A (L1 fully bought, L2 partial),
 * requisition B (L3 not bought; L4 left out for another batch), an extra
 * pending product, a freight expense (with receipt) and a meal expense. Returns everything, marked purchased.
 */
async function buildMixedBatch(s: Setup, buyer: Id<"users"> = s.inventory) {
  const asBuyer = s.as(buyer);
  const reqA = await s.approvedRequisition([[s.p1, 10], [s.p2, 5]]);
  const reqB = await s.approvedRequisition([[s.p3, 4], [s.p4, 2]]);
  const [l1, l2] = reqA.lineIds;
  const [l3, l4] = reqB.lineIds;

  const batchId = await asBuyer.mutation(api.stockBatches.create, { businessUnitKey: "hair", title: "Guangzhou trip" });
  await asBuyer.mutation(api.stockBatches.addRequisitionLines, { batchId, requisitionItemIds: [l1, l2, l3] });

  // Inline new product while purchasing: pending confirmation for the buyer.
  const extraProduct = await asBuyer.mutation(api.products.create, {
    businessUnitKey: "hair",
    name: "New closure",
    category: "closures",
    unit: "piece",
  });
  const extraId = await asBuyer.mutation(api.stockBatches.addExtraItem, {
    batchId,
    productId: extraProduct,
    qtyPurchased: 3,
    unitCost: 500,
  });

  const i1 = await batchItemFor(s, l1);
  const i2 = await batchItemFor(s, l2);
  const i3 = await batchItemFor(s, l3);
  await asBuyer.mutation(api.stockBatches.updateItem, { itemId: i1._id, status: "purchased", qtyPurchased: 10, unitCost: 200 });
  await asBuyer.mutation(api.stockBatches.updateItem, { itemId: i2._id, status: "purchased", qtyPurchased: 3, unitCost: 1000 });

  // Incomplete: L2 bought fewer without a reason; L3 has no cost and no decision.
  const incomplete = await asBuyer
    .mutation(api.stockBatches.markPurchased, { batchId })
    .then(() => null, (e) => e);
  expect(incomplete.data).toMatchObject({ code: "INCOMPLETE" });
  const problems = Object.fromEntries(
    (incomplete.data.lines as Array<{ itemId: string; problems: string[] }>).map((l) => [l.itemId, l.problems]),
  );
  expect(problems).toEqual({ [i2._id]: ["reason"], [i3._id]: ["unitCost"] });

  await asBuyer.mutation(api.stockBatches.updateItem, {
    itemId: i2._id,
    status: "purchased",
    qtyPurchased: 3,
    unitCost: 1000,
    reason: "Supplier only had 3",
  });
  await asBuyer.mutation(api.stockBatches.updateItem, {
    itemId: i3._id,
    status: "not_purchased",
    qtyPurchased: 4,
    unitCost: null,
    reason: "Discontinued",
  });

  const receipt = await s.t.run((ctx) => ctx.storage.store(new Blob(["%PDF"], { type: "application/pdf" })));
  await asBuyer.mutation(api.stockBatches.addExpense, {
    batchId,
    category: "freight",
    amount: 800,
    receiptFileId: receipt,
  });
  await asBuyer.mutation(api.stockBatches.addExpense, {
    batchId,
    category: "meals",
    amount: 300,
    note: "Team lunch",
  });

  await asBuyer.mutation(api.stockBatches.markPurchased, { batchId });
  return { batchId, reqA, reqB, l1, l2, l3, l4, i1, i2, i3, extraId, extraProduct };
}

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
  ).rejects.toThrow(/stock\.distribute/);
  await s.as(s.manager).mutation(api.stockBatches.markArrived, { batchId: b.batchId });
  await s.as(s.chief).mutation(api.stockBatches.markReceived, { batchId: b.batchId });

  const batch = await getBatch(s, b.batchId);
  expect(batch).toMatchObject({ status: "received" });
  for (const stamp of ["purchasedAt", "approvedAt", "shippedAt", "arrivedAt", "receivedAt"] as const) {
    expect(batch![stamp]).toBeTypeOf("number");
  }
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
  await s.as(s.chief).mutation(api.stockBatches.markReceived, { batchId: b.batchId });
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
    s.as(s.sales).mutation(api.stockBatches.addExpense, { batchId: b.batchId, category: "other", amount: 100 }),
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
  await s.as(s.superAdmin).mutation(api.stockBatches.markReceived, { batchId: own });
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
