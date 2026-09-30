// Test-only helpers for the stock tests (convex/stockBatches.test.ts,
// convex/distributions.test.ts). Two dots in the name: the Convex CLI skips
// it (see test.utils.ts), and vitest doesn't take it for a test file.
import { convexTest } from "convex-test";
import { expect } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  getBusinessUnitId,
  insertLocation,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./test.utils";

export const PAGE = { numItems: 50, cursor: null };

type Modules = Record<string, () => Promise<unknown>>;

/**
 * A seeded Hair unit with a shop, the stock roles and four products; the
 * caller passes its `import.meta.glob` modules (they must be globbed from
 * convex/, so each test file does it itself).
 */
export async function setupStock(modules: Modules) {
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

export type Setup = Awaited<ReturnType<typeof setupStock>>;

export const getBatch = (s: Setup, id: Id<"stockBatches">) => s.t.run((ctx) => ctx.db.get("stockBatches", id));
export const getLine = (s: Setup, id: Id<"requisitionItems">) => s.t.run((ctx) => ctx.db.get("requisitionItems", id));
export const getRequisition = (s: Setup, id: Id<"requisitions">) => s.t.run((ctx) => ctx.db.get("requisitions", id));

export async function batchItemFor(s: Setup, lineId: Id<"requisitionItems">) {
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
export async function buildMixedBatch(s: Setup, buyer: Id<"users"> = s.inventory) {
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

/** Counts every purchased line as fully arrived and confirms the receipt. */
export async function receiveAll(s: Setup, batchId: Id<"stockBatches">, receiver: Id<"users"> = s.manager) {
  const items = await s.t.run((ctx) =>
    ctx.db.query("stockBatchItems").withIndex("by_batchId", (q) => q.eq("batchId", batchId)).collect(),
  );
  for (const item of items) {
    if (item.status !== "purchased") continue;
    await s.as(receiver).mutation(api.stockBatches.setReceiveCount, {
      itemId: item._id,
      qtyReceived: item.qtyPurchased,
      qtyDamaged: 0,
    });
  }
  await s.as(receiver).mutation(api.stockBatches.confirmReceipt, { batchId });
}

/** The mixed batch, approved, shipped and arrived in Goma (ready to count). */
export async function arrivedMixedBatch(s: Setup) {
  const b = await buildMixedBatch(s);
  const approvalId = await s.as(s.inventory).mutation(api.stockBatches.submitForApproval, { batchId: b.batchId });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  await s.as(s.inventory).mutation(api.stockBatches.markShipped, { batchId: b.batchId });
  await s.as(s.manager).mutation(api.stockBatches.markArrived, { batchId: b.batchId });
  return b;
}
