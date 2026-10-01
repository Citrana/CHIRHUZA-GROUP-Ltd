import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
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
  const shop = await insertLocation(t, { name: "Kenya Shop" });
  const otherShop = await insertLocation(t, { name: "Other Shop" });
  const closedShop = await insertLocation(t, { name: "Closed", active: false });

  const sales = await insertUserWithRole(t, "chief_sales_admin", { email: "sales@x.com", name: "Sales" });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const inventory = await insertUserWithRole(t, "chief_inventory_admin", { email: "inv@x.com", name: "Inventory" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "super@x.com", name: "Super" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", locationId: shop });

  const product = (name: string, overrides: Record<string, unknown> = {}) =>
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
        ...overrides,
      }),
    );
  const wig = await product("Wig");
  const closure = await product("Closure");
  const archived = await product("Archived", { status: "archived" });
  const pending = await product("Pending", { status: "pending_confirmation" });

  return {
    t, hairId, shop, otherShop, closedShop,
    sales, chief, inventory, superAdmin, agent,
    wig, closure, archived, pending,
    as: (user: Id<"users">) => t.withIdentity({ subject: user }),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function draft(s: Setup, by: Id<"users"> = s.sales) {
  const id = await s.as(by).mutation(api.requisitions.create, {
    businessUnitKey: "hair",
    locationId: s.shop,
    note: "For the weekend",
  });
  return id;
}

const getReq = (s: Setup, id: Id<"requisitions">) => s.t.run((ctx) => ctx.db.get("requisitions", id));

async function approvalFor(s: Setup, id: Id<"requisitions">) {
  return (await getReq(s, id))!.approvalId!;
}

test("a Chief Sales Admin creates numbered drafts for an active location of the service", async () => {
  const s = await setup();
  const first = await draft(s);
  const second = await draft(s);
  expect(await getReq(s, first)).toMatchObject({ number: "REQ-00001", status: "draft", createdBy: s.sales, note: "For the weekend" });
  expect((await getReq(s, second))!.number).toBe("REQ-00002");

  for (const locationId of [s.closedShop]) {
    await expect(
      s.as(s.sales).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId }),
    ).rejects.toThrow(/active location/);
  }
  await expect(
    s.as(s.agent).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.shop }),
  ).rejects.toThrow(/requisition\.create/);
});

test("own_location creators may only use their own location", async () => {
  const s = await setup();
  // Give Sales Agents requisition.create at own_location.
  const agentRoleId = await getRoleId(s.t, "sales_agent");
  await s.t.run(async (ctx) => {
    const permission = await ctx.db
      .query("permissions")
      .withIndex("by_key", (q) => q.eq("key", "requisition.create"))
      .unique();
    await ctx.db.insert("rolePermissions", {
      roleId: agentRoleId,
      permissionId: permission!._id,
      scope: "own_location",
    });
  });
  await s.as(s.agent).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.shop });
  await expect(
    s.as(s.agent).mutation(api.requisitions.create, { businessUnitKey: "hair", locationId: s.otherShop }),
  ).rejects.toThrow(/your own location/);
});

test("lines: active products of the service only, one line per product, whole quantities", async () => {
  const s = await setup();
  const id = await draft(s);
  const asSales = s.as(s.sales);
  const itemId = await asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 5 });

  for (const productId of [s.archived, s.pending]) {
    await expect(
      asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId, qtyRequested: 1 }),
    ).rejects.toThrow(/active product/);
  }
  await expect(
    asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 1 }),
  ).rejects.toThrow(/already on the requisition/);
  for (const qty of [0, -1, 2.5]) {
    await expect(
      asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.closure, qtyRequested: qty }),
    ).rejects.toThrow(/whole number/);
  }

  await asSales.mutation(api.requisitions.updateItem, { itemId, qtyRequested: 8, note: "Black only" });
  const closureLine = await asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.closure, qtyRequested: 2 });
  await asSales.mutation(api.requisitions.removeItem, { itemId: closureLine });

  const detail = await asSales.query(api.requisitions.get, { requisitionId: id });
  expect(detail!.items.map((i) => [i.productName, i.qtyRequested, i.note, i.resolution])).toEqual([
    ["Wig", 8, "Black only", "pending"],
  ]);
  expect(detail).toMatchObject({ canEdit: true, canSubmit: true, locationName: "Kenya Shop", businessUnitKey: "hair" });

  const itemAudit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "requisitionItems").map((a) => a.action),
  );
  expect(itemAudit).toEqual(["create", "update", "create", "delete"]);
});

test("only the creator (or the Super Admin) edits, and only while draft or rejected", async () => {
  const s = await setup();
  const id = await draft(s);
  // Another creator can't touch it.
  const otherCreator = await insertUserWithRole(s.t, "chief_sales_admin", { email: "s3@x.com" });
  await expect(
    s.as(otherCreator).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 1 }),
  ).rejects.toThrow(/Only the person who created/);
  expect((await s.as(s.chief).query(api.requisitions.get, { requisitionId: id }))!.canEdit).toBe(false);

  // The Super Admin can edit anyone's draft...
  expect((await s.as(s.superAdmin).query(api.requisitions.get, { requisitionId: id }))!.canEdit).toBe(true);
  await s.as(s.superAdmin).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 1 });
  await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId: id });
  // ...but not once it's submitted.
  await expect(
    s.as(s.superAdmin).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.closure, qtyRequested: 1 }),
  ).rejects.toThrow(/waiting for approval/);
});

test("submitting needs a line, creates a requisition approval and locks the draft", async () => {
  const s = await setup();
  const id = await draft(s);
  const asSales = s.as(s.sales);
  await expect(asSales.mutation(api.requisitions.submit, { requisitionId: id })).rejects.toThrow(/at least one product/);

  await asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 3 });
  await asSales.mutation(api.requisitions.submit, { requisitionId: id });

  const requisition = await getReq(s, id);
  expect(requisition).toMatchObject({ status: "submitted" });
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", requisition!.approvalId!));
  expect(approval).toMatchObject({
    type: "requisition",
    entityTable: "requisitions",
    entityId: id,
    requiredPermission: "requisition.approve",
    requestedBy: s.sales,
    locationId: s.shop,
    status: "pending",
    reason: "For the weekend",
    payload: { after: { number: "REQ-00001", location: "Kenya Shop", itemCount: 1, items: "Wig (HAIR-Wig) × 3" } },
  });

  await expect(
    asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.closure, qtyRequested: 1 }),
  ).rejects.toThrow(/waiting for approval/);
});

test("the Chief Admin approves; creators can't approve their own (except the Super Admin); approved is locked", async () => {
  const s = await setup();
  // The Super Admin may approve their own requisition - flagged in the audit.
  const own = await draft(s, s.superAdmin);
  await s.as(s.superAdmin).mutation(api.requisitions.addItem, { requisitionId: own, productId: s.wig, qtyRequested: 1 });
  await s.as(s.superAdmin).mutation(api.requisitions.submit, { requisitionId: own });
  const ownApproval = await approvalFor(s, own);
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId: ownApproval, decision: "approve" });
  expect((await getReq(s, own))!.status).toBe("approved");
  const decision = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find(
      (a) => a.entityTable === "approvals" && a.entityId === ownApproval && a.action === "approve",
    ),
  );
  expect(decision!.after).toMatchObject({ status: "approved", selfApproved: true });

  // (Non-Super-Admins can't decide their own requests - see approvals.test.ts.
  // A Chief Admin can't even create requisitions.)
  await expect(draft(s, s.chief)).rejects.toThrow(/requisition\.create/);

  const id = await draft(s);
  await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 2 });
  await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId: id });
  // The Chief Inventory Admin can see it but not approve it.
  await expect(
    s.as(s.inventory).mutation(api.approvals.decideApproval, { approvalId: await approvalFor(s, id), decision: "approve" }),
  ).rejects.toThrow(/requisition\.approve/);

  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalFor(s, id), decision: "approve" });
  expect((await getReq(s, id))!.status).toBe("approved");
  await expect(
    s.as(s.sales).mutation(api.requisitions.update, { requisitionId: id, locationId: s.otherShop }),
  ).rejects.toThrow(/Approved requisitions can't be changed/);

  const audit = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "requisitions" && a.entityId === id),
  );
  expect(audit.map((a) => [a.action, a.after?.status])).toEqual([
    ["create", "draft"],
    ["update", "submitted"],
    ["update", "approved"],
  ]);
  expect(audit[2].actorId).toBe(s.chief);
});

test("rejected requisitions go back to the creator, who revises and resubmits", async () => {
  const s = await setup();
  const id = await draft(s);
  const asSales = s.as(s.sales);
  const lineId = await asSales.mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 20 });
  await asSales.mutation(api.requisitions.submit, { requisitionId: id });
  const firstApproval = await approvalFor(s, id);

  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: firstApproval, decision: "reject", note: "Too many" });
  const detail = await asSales.query(api.requisitions.get, { requisitionId: id });
  expect(detail).toMatchObject({
    status: "rejected",
    canEdit: true,
    approval: { status: "rejected", decisionNote: "Too many", decidedByName: "Chief" },
  });

  await asSales.mutation(api.requisitions.updateItem, { itemId: lineId, qtyRequested: 10 });
  await asSales.mutation(api.requisitions.submit, { requisitionId: id });
  const secondApproval = await approvalFor(s, id);
  expect(secondApproval).not.toBe(firstApproval);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: secondApproval, decision: "approve" });
  expect((await getReq(s, id))!.status).toBe("approved");
});

test("a stale approval can't change a requisition", async () => {
  const s = await setup();
  const id = await draft(s);
  await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 1 });
  await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId: id });
  const approvalId = await approvalFor(s, id);
  // Simulate the requisition having moved on (e.g. an older submission).
  await s.t.run((ctx) => ctx.db.patch("requisitions", id, { approvalId: undefined }));
  await expect(
    s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" }),
  ).rejects.toThrow(/no longer waiting/);
  expect((await s.t.run((ctx) => ctx.db.get("approvals", approvalId)))!.status).toBe("pending");
});

test("requisition.view sees every requisition (drafts too); creators see their own", async () => {
  const s = await setup();
  const salesDraft = await draft(s);
  const approved = await draft(s);
  await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId: approved, productId: s.wig, qtyRequested: 1 });
  await s.as(s.sales).mutation(api.requisitions.submit, { requisitionId: approved });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalFor(s, approved), decision: "approve" });

  const numbers = async (who: Id<"users">, status?: "approved") =>
    (
      await s.as(who).query(api.requisitions.list, {
        businessUnitKey: "hair",
        paginationOpts: PAGE,
        ...(status ? { status } : {}),
      })
    ).page.map((r) => r._id);

  expect(await numbers(s.inventory)).toEqual([approved, salesDraft]);
  expect(await numbers(s.inventory, "approved")).toEqual([approved]);
  expect((await s.as(s.inventory).query(api.requisitions.get, { requisitionId: salesDraft }))!.canEdit).toBe(false);

  // A creator without requisition.view (Chief Sales Admin by default)
  // sees only their own.
  const creatorOnly = await insertUserWithRole(s.t, "chief_sales_admin", { email: "s2@x.com" });
  const perms = await s.as(creatorOnly).query(api.rbac.getMyPermissions, {});
  expect(perms["requisition.view"]).toBeUndefined();
  const mine = await draft(s, creatorOnly);
  expect(await numbers(creatorOnly)).toEqual([mine]);
  expect(await s.as(creatorOnly).query(api.requisitions.get, { requisitionId: salesDraft })).toBeNull();

  await expect(
    s.as(s.agent).query(api.requisitions.list, { businessUnitKey: "hair", paginationOpts: PAGE }),
  ).rejects.toThrow(/requisition\.create/);
});

test("locationOptions lists the active locations the caller may use", async () => {
  const s = await setup();
  const names = (await s.as(s.sales).query(api.requisitions.locationOptions, { businessUnitKey: "hair" })).map(
    (l) => l.name,
  );
  expect(names).toEqual(["Kenya Shop", "Other Shop"]);
  await expect(
    s.as(s.inventory).query(api.requisitions.locationOptions, { businessUnitKey: "hair" }),
  ).rejects.toThrow(/requisition\.create/);
});

test("a product on a requisition can't be deleted, only archived", async () => {
  const s = await setup();
  const id = await draft(s);
  await s.as(s.sales).mutation(api.requisitions.addItem, { requisitionId: id, productId: s.wig, qtyRequested: 1 });

  const product = await s.as(s.chief).query(api.products.get, { productId: s.wig });
  expect(product!.inUse).toBe(true);
  await expect(
    s.as(s.chief).mutation(api.products.requestDeletion, { productId: s.wig, reason: "Old" }),
  ).rejects.toThrow(/Archive it instead/);
  await s.as(s.chief).mutation(api.products.setArchived, { productId: s.wig, archived: true });
});
