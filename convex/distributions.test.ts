import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PAGE, arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";
import { insertUserWithRole } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

/** Purchase -> ship -> arrive -> receive: the business holds 10 / 3 / 3 units. */
async function withStock() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const options = await s.as(s.manager).query(api.distributions.options, { businessUnitKey: "hair" });
  const lotOf = (productName: string) => options.lots.find((l) => l.productName === productName)!._id;
  return { s, b, options, p1Lot: lotOf("P1"), p2Lot: lotOf("P2") };
}

const toShop = (s: Setup, lines: Array<{ inventoryBatchId: Id<"inventoryBatches">; qty: number }>, who = s.manager) =>
  s.as(who).mutation(api.distributions.create, {
    businessUnitKey: "hair",
    to: { type: "location", id: s.shop },
    lines,
  });

async function approvalOf(s: Setup, distributionId: Id<"distributions">) {
  return (await s.t.run((ctx) => ctx.db.get("distributions", distributionId)))!.approvalId!;
}

async function overview(s: Setup, who = s.chief) {
  return await s.as(who).query(api.inventory.overview, { businessUnitKey: "hair" });
}

test("purchase -> ship -> receive -> distribute -> stock visible at the shop", async () => {
  const { s, options, p1Lot, p2Lot } = await withStock();
  expect(options.lots.map((l) => [l.productName, l.available])).toEqual([
    ["New closure", 3],
    ["P1", 10],
    ["P2", 3],
  ]);
  expect(options.locations.map((l) => l.name)).toEqual(["Goma Shop"]);

  const id = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 4 }, { inventoryBatchId: p2Lot, qty: 3 }]);
  // Pending: nothing has moved yet.
  expect((await overview(s)).byHolder.map((h) => [h.holder.name, h.qty])).toEqual([["business", 16]]);

  // Needs stock.approve: the manager can't approve (nor could they approve their own).
  const approvalId = await approvalOf(s, id);
  // The approver sees each line's product, inches, colour and pieces.
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", approvalId));
  expect(approval!.payload).toMatchObject({
    after: {
      number: "DIST-00001",
      to: "Goma Shop",
      totalQty: 7,
      items: [
        { product: "P1", lengthInches: null, colour: null, sku: "HAIR-P1", batch: "BATCH-00001", qty: 4 },
        { product: "P2", sku: "HAIR-P2", batch: "BATCH-00001", qty: 3 },
      ],
    },
  });
  await expect(
    s.as(s.manager).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" }),
  ).rejects.toThrow(/stock\.approve/);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });

  const after = await overview(s);
  expect(after.byHolder.map((h) => [h.holder.name, h.qty])).toEqual([["business", 9], ["Goma Shop", 7]]);
  const shop = after.byHolder.find((h) => h.holder.name === "Goma Shop")!;
  expect(shop.lines.map((l) => [l.product.name, l.lot.batchNumber, l.qty])).toEqual([
    ["P1", "BATCH-00001", 4],
    ["P2", "BATCH-00001", 3],
  ]);
  expect(after.byProduct.find((p) => p.product.name === "P1")!.holders.map((h) => [h.holder.name, h.qty])).toEqual([
    ["business", 6],
    ["Goma Shop", 4],
  ]);

  const [distribution] = (await s.as(s.chief).query(api.distributions.list, { businessUnitKey: "hair", paginationOpts: PAGE })).page;
  expect(distribution).toMatchObject({ number: "DIST-00001", status: "approved", toName: "Goma Shop", totalQty: 7, decidedByName: "Chief" });
  const movements = await s.t.run((ctx) =>
    ctx.db.query("inventoryMovements").withIndex("by_refTable_and_refId", (q) => q.eq("refTable", "distributions").eq("refId", id)).collect(),
  );
  expect(movements.map((m) => [m.type, m.qty])).toEqual([["distribute", 4], ["distribute", 3]]);
});

test("a person can hold stock too; the Chief Sales Admin can submit", async () => {
  const { s, p1Lot } = await withStock();
  const id = await s.as(s.sales).mutation(api.distributions.create, {
    businessUnitKey: "hair",
    to: { type: "user", id: s.agent },
    lines: [{ inventoryBatchId: p1Lot, qty: 2 }],
    note: "For the market stall",
  });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, id), decision: "approve" });
  const agentHolder = (await overview(s)).byHolder.find((h) => h.holder.type === "user")!;
  expect(agentHolder).toMatchObject({ qty: 2 });
});

test("can't ask for more than is available, counting pending distributions", async () => {
  const { s, p1Lot } = await withStock();
  await expect(toShop(s, [{ inventoryBatchId: p1Lot, qty: 11 }])).rejects.toThrow(/Only 10 of P1 available/);
  await toShop(s, [{ inventoryBatchId: p1Lot, qty: 7 }]);
  await expect(toShop(s, [{ inventoryBatchId: p1Lot, qty: 4 }])).rejects.toThrow(/Only 3 of P1 available/);
  const options = await s.as(s.manager).query(api.distributions.options, { businessUnitKey: "hair" });
  expect(options.lots.find((l) => l._id === p1Lot)).toMatchObject({ onHand: 10, available: 3 });
  // Bad input.
  await expect(toShop(s, [])).rejects.toThrow(/at least one line/);
  await expect(toShop(s, [{ inventoryBatchId: p1Lot, qty: 0 }])).rejects.toThrow(/whole numbers from 1/);
  await expect(
    toShop(s, [{ inventoryBatchId: p1Lot, qty: 1 }, { inventoryBatchId: p1Lot, qty: 1 }]),
  ).rejects.toThrow(/only once/);
  // Needs stock.distribute.
  await expect(toShop(s, [{ inventoryBatchId: p1Lot, qty: 1 }], s.inventory)).rejects.toThrow(/stock\.distribute/);
});

test("pending distributions that fit together are both approved; then the lot is exhausted", async () => {
  const { s, p1Lot } = await withStock();
  const first = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 6 }]);
  const second = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 4 }]);

  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, first), decision: "approve" });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, second), decision: "approve" });
  // Both fit (6 + 4 = 10). Now the business has none of P1 left.
  const p1 = (await overview(s)).byProduct.find((p) => p.product.name === "P1")!;
  expect(p1.holders.map((h) => [h.holder.name, h.qty])).toEqual([["Goma Shop", 10]]);
  await expect(toShop(s, [{ inventoryBatchId: p1Lot, qty: 1 }])).rejects.toThrow(/Only 0 of P1 available/);
});

test("stock can't go negative even if two pending distributions over-ask", async () => {
  const { s, p1Lot } = await withStock();
  const first = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 6 }]);
  // Force an over-asking second request past the submit check (as if two
  // people submitted at the same moment): 6 + 6 > 10.
  const second = await s.t.run(async (ctx) => {
    const d = (await ctx.db.get("distributions", first))!;
    const id = await ctx.db.insert("distributions", { ...d, _id: undefined, _creationTime: undefined, number: "DIST-99999", approvalId: undefined } as never);
    await ctx.db.insert("distributionItems", { distributionId: id, inventoryBatchId: p1Lot, qty: 6 });
    return id;
  });
  const secondApproval = await s.t.run(async (ctx) => {
    const approval = (await ctx.db.get("approvals", (await ctx.db.get("distributions", first))!.approvalId!))!;
    const { _id, _creationTime, ...rest } = approval;
    void _id;
    void _creationTime;
    const approvalId = await ctx.db.insert("approvals", { ...rest, entityId: second });
    await ctx.db.patch("distributions", second, { approvalId });
    return approvalId;
  });

  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, first), decision: "approve" });
  await expect(
    s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: secondApproval, decision: "approve" }),
  ).rejects.toThrow(/Not enough stock: 4 on hand, 6 requested/);

  // The failed approval stays pending and nothing moved for it.
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", secondApproval));
  expect(approval!.status).toBe("pending");
  expect((await s.t.run((ctx) => ctx.db.get("distributions", second)))!.status).toBe("pending");
  const p1 = (await overview(s)).byProduct.find((p) => p.product.name === "P1")!;
  expect(p1.holders.map((h) => [h.holder.name, h.qty])).toEqual([["business", 4], ["Goma Shop", 6]]);
  const levels = await s.t.run((ctx) => ctx.db.query("stockLevels").collect());
  expect(levels.every((l) => l.qtyOnHand >= 0)).toBe(true);
});

test("a rejected distribution moves nothing and frees the stock", async () => {
  const { s, p1Lot } = await withStock();
  const id = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 10 }]);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, id), decision: "reject", note: "Not now" });
  expect((await s.t.run((ctx) => ctx.db.get("distributions", id)))!.status).toBe("rejected");
  expect((await overview(s)).byHolder.map((h) => [h.holder.name, h.qty])).toEqual([["business", 16]]);
  // Available again.
  await toShop(s, [{ inventoryBatchId: p1Lot, qty: 10 }]);
});

test("nobody approves their own distribution, except the Super Admin (flagged)", async () => {
  const { s, p1Lot } = await withStock();
  // A Chief Admin role holder who could both submit and approve: give the
  // requester stock.approve by using the Super Admin for contrast.
  const own = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 1 }], s.superAdmin);
  const ownApproval = await approvalOf(s, own);
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId: ownApproval, decision: "approve" });
  const decision = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find(
      (a) => a.entityTable === "approvals" && a.entityId === ownApproval && a.action === "approve",
    ),
  );
  expect(decision!.after).toMatchObject({ selfApproved: true });

  // A second chief who submits can't approve it themselves.
  const chief2 = await insertUserWithRole(s.t, "chief_admin", { email: "chief2@x.com", name: "Chief 2" });
  await s.t.run(async (ctx) => {
    const role = (await ctx.db.get("users", chief2))!.roleId!;
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "stock.distribute")!;
    await ctx.db.insert("rolePermissions", { roleId: role, permissionId: permission._id, scope: "all_locations" });
  });
  const theirs = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 1 }], chief2);
  await expect(
    s.as(chief2).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, theirs), decision: "approve" }),
  ).rejects.toThrow(/own request/);
});

test("an own_location viewer sees only their location's stock", async () => {
  const { s, p1Lot } = await withStock();
  const id = await toShop(s, [{ inventoryBatchId: p1Lot, qty: 3 }]);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, id), decision: "approve" });
  // A shop keeper with stock.view scoped to their own location.
  const keeper = await insertUserWithRole(s.t, "sales_agent", { email: "keeper@x.com", locationId: s.shop });
  await s.t.run(async (ctx) => {
    const role = (await ctx.db.get("users", keeper))!.roleId!;
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "stock.view")!;
    await ctx.db.insert("rolePermissions", { roleId: role, permissionId: permission._id, scope: "own_location" });
  });
  const view = await overview(s, keeper);
  expect(view.scope).toBe("own_location");
  expect(view.byHolder.map((h) => [h.holder.name, h.qty])).toEqual([["Goma Shop", 3]]);
  const list = await s.as(keeper).query(api.distributions.list, { businessUnitKey: "hair", paginationOpts: PAGE });
  expect(list.page.map((d) => d.toName)).toEqual(["Goma Shop"]);
});
