import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { productUsage } from "./lib/products";
import {
  getBusinessUnitId,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const hairId = await getBusinessUnitId(t, "hair");
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const chief2 = await insertUserWithRole(t, "chief_sales_admin", { email: "cs@x.com", name: "Chief Sales" });
  const inventory = await insertUserWithRole(t, "chief_inventory_admin", { email: "inv@x.com", name: "Inventory" });
  await t.run(async (ctx) => {
    await ctx.db.insert("productLengths", { businessUnitId: hairId, inches: 18, active: true });
    await ctx.db.insert("productLengths", { businessUnitId: hairId, inches: 24, active: true });
    await ctx.db.insert("productLengths", { businessUnitId: hairId, inches: 30, active: false });
  });
  const [black, blonde] = await t.run(async (ctx) => [
    await ctx.db.insert("productColours", { businessUnitId: hairId, name: "1B", active: true }),
    await ctx.db.insert("productColours", { businessUnitId: hairId, name: "Blonde", active: false }),
  ]);
  return { t, hairId, chief, chief2, inventory, black, blonde };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function create(s: Setup, as: Id<"users">, overrides: Record<string, unknown> = {}) {
  return s.t.withIdentity({ subject: as }).mutation(api.products.create, {
    businessUnitKey: "hair",
    name: "Body wave wig",
    category: "wigs",
    unit: "piece",
    ...overrides,
  });
}

const getProduct = (s: Setup, id: Id<"products">) =>
  s.t.run((ctx) => ctx.db.get("products", id));

const auditFor = (s: Setup, id: string) =>
  s.t.run((ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_entityTable_and_entityId_and_timestamp", (q) =>
        q.eq("entityTable", "products").eq("entityId", id),
      )
      .collect(),
  );

test("a chief creates an active product; others create it pending confirmation", async () => {
  const s = await setup();
  const active = await create(s, s.chief, { brand: " Queen ", lengthInches: 18, colourId: s.black });
  const pending = await create(s, s.inventory, { name: "Closure 4x4", category: "closures" });

  expect(await getProduct(s, active)).toMatchObject({
    status: "active",
    brand: "Queen",
    lengthInches: 18,
    colourId: s.black,
    confirmedBy: s.chief,
    createdBy: s.chief,
  });
  expect(await getProduct(s, pending)).toMatchObject({
    status: "pending_confirmation",
    createdBy: s.inventory,
  });
  expect((await getProduct(s, pending))!.confirmedBy).toBeUndefined();

  const audit = await auditFor(s, active);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "create",
    actorId: s.chief,
    businessUnitId: s.hairId,
    after: { name: "Body wave wig", colour: "1B", lengthInches: 18, status: "active" },
  });
});

test("SKUs are generated per business unit, sequential and unique", async () => {
  const s = await setup();
  const a = await create(s, s.chief);
  const b = await create(s, s.chief, { name: "Second" });
  expect((await getProduct(s, a))!.sku).toBe("HAIR-00001");
  expect((await getProduct(s, b))!.sku).toBe("HAIR-00002");
});

test("length and colour must be active product settings", async () => {
  const s = await setup();
  await expect(create(s, s.chief, { lengthInches: 20 })).rejects.toThrow(/length/);
  await expect(create(s, s.chief, { lengthInches: 30 })).rejects.toThrow(/length/);
  await expect(create(s, s.chief, { colourId: s.blonde })).rejects.toThrow(/colour/);
  await expect(create(s, s.chief, { name: "   " })).rejects.toThrow(/name is required/);
});

test("update audits only the changed fields and keeps a now-inactive value", async () => {
  const s = await setup();
  const id = await create(s, s.chief, { lengthInches: 18, colourId: s.black });
  await s.t.run(async (ctx) => {
    await ctx.db.patch("productColours", s.black, { active: false });
  });
  const asChief = s.t.withIdentity({ subject: s.chief });

  await asChief.mutation(api.products.update, {
    productId: id,
    name: "Body wave wig",
    category: "wigs",
    unit: "piece",
    lengthInches: 24,
    colourId: s.black, // unchanged, allowed although inactive now
    texture: "Body wave",
  });
  const product = await getProduct(s, id);
  expect(product).toMatchObject({ lengthInches: 24, texture: "Body wave", sku: "HAIR-00001" });
  expect(product!.searchText).toContain("body wave");

  const updates = (await auditFor(s, id)).filter((a) => a.action === "update");
  expect(updates).toHaveLength(1);
  expect(updates[0].before).toEqual({ lengthInches: 18, texture: null });
  expect(updates[0].after).toEqual({ lengthInches: 24, texture: "Body wave" });

  // A no-op edit writes nothing.
  await asChief.mutation(api.products.update, {
    productId: id,
    name: "Body wave wig",
    category: "wigs",
    unit: "piece",
    lengthInches: 24,
    colourId: s.black,
    texture: "Body wave",
  });
  expect((await auditFor(s, id)).filter((a) => a.action === "update")).toHaveLength(1);
});

test("pending products are confirmed by a chief - never by their creator", async () => {
  const s = await setup();
  const byInventory = await create(s, s.inventory);
  await expect(
    s.t.withIdentity({ subject: s.inventory }).mutation(api.products.confirm, { productId: byInventory }),
  ).rejects.toThrow(/products\.confirm/);

  await s.t.withIdentity({ subject: s.chief }).mutation(api.products.confirm, { productId: byInventory });
  expect(await getProduct(s, byInventory)).toMatchObject({ status: "active", confirmedBy: s.chief });
  const audit = await auditFor(s, byInventory);
  expect(audit[1]).toMatchObject({
    action: "update",
    before: { status: "pending_confirmation" },
    after: { status: "active" },
  });

  // A chief who created a pending product (e.g. via a restore) can't confirm it.
  const own = await s.t.run((ctx) =>
    ctx.db.insert("products", {
      businessUnitId: s.hairId,
      name: "Own",
      sku: "HAIR-09999",
      category: "wigs",
      unit: "piece",
      status: "pending_confirmation",
      createdBy: s.chief,
      searchText: "own",
    }),
  );
  await expect(
    s.t.withIdentity({ subject: s.chief }).mutation(api.products.confirm, { productId: own }),
  ).rejects.toThrow(/you created/);
  await s.t.withIdentity({ subject: s.chief2 }).mutation(api.products.confirm, { productId: own });
});

test("get reports whether this user can confirm", async () => {
  const s = await setup();
  const id = await create(s, s.inventory);
  const asInventory = await s.t.withIdentity({ subject: s.inventory }).query(api.products.get, { productId: id });
  const asChief = await s.t.withIdentity({ subject: s.chief }).query(api.products.get, { productId: id });
  expect(asInventory).toMatchObject({ canConfirm: false, createdByName: "Inventory" });
  expect(asChief).toMatchObject({ canConfirm: true, pendingDeletionApprovalId: null, inUse: false });
});

test("archiving and restoring return a product to its right status", async () => {
  const s = await setup();
  const confirmed = await create(s, s.chief);
  const pending = await create(s, s.inventory, { name: "Pending one" });
  const asChief = s.t.withIdentity({ subject: s.chief });

  for (const id of [confirmed, pending]) {
    await asChief.mutation(api.products.setArchived, { productId: id, archived: true });
    expect((await getProduct(s, id))!.status).toBe("archived");
    await asChief.mutation(api.products.setArchived, { productId: id, archived: false });
  }
  expect((await getProduct(s, confirmed))!.status).toBe("active");
  expect((await getProduct(s, pending))!.status).toBe("pending_confirmation");
});

test("deletion goes through approvals: approving deletes and audits, rejecting keeps it", async () => {
  const s = await setup();
  const doomed = await create(s, s.chief, { name: "Doomed" });
  const kept = await create(s, s.chief, { name: "Kept" });
  const asInventory = s.t.withIdentity({ subject: s.inventory });

  await expect(
    asInventory.mutation(api.products.requestDeletion, { productId: doomed, reason: "  " }),
  ).rejects.toThrow(/reason/);
  const approveId = await asInventory.mutation(api.products.requestDeletion, {
    productId: doomed,
    reason: "Duplicate entry",
  });
  const rejectId = await asInventory.mutation(api.products.requestDeletion, {
    productId: kept,
    reason: "Not sure",
  });

  // Still there, flagged as pending deletion, and can't be requested twice.
  expect(await getProduct(s, doomed)).not.toBeNull();
  const listed = await s.t
    .withIdentity({ subject: s.chief })
    .query(api.products.list, { businessUnitKey: "hair", paginationOpts: PAGE });
  expect(listed.page.find((p) => p._id === doomed)?.pendingDeletion).toBe(true);
  await expect(
    asInventory.mutation(api.products.requestDeletion, { productId: doomed, reason: "Again" }),
  ).rejects.toThrow(/already pending/);

  const asChief = s.t.withIdentity({ subject: s.chief });
  await asChief.mutation(api.approvals.decideApproval, { approvalId: approveId, decision: "approve" });
  await asChief.mutation(api.approvals.decideApproval, { approvalId: rejectId, decision: "reject" });

  expect(await getProduct(s, doomed)).toBeNull();
  expect(await getProduct(s, kept)).not.toBeNull();
  const deleted = (await auditFor(s, doomed)).find((a) => a.action === "delete");
  expect(deleted).toMatchObject({
    actorId: s.chief,
    reason: "Duplicate entry",
    before: { name: "Doomed", sku: "HAIR-00001" },
  });
});

test("products in use can't be deleted - at request time or when approving", async () => {
  const s = await setup();
  const id = await create(s, s.chief);
  const inUse = vi.spyOn(productUsage, "isProductInUse").mockResolvedValue(true);
  await expect(
    s.t.withIdentity({ subject: s.inventory }).mutation(api.products.requestDeletion, {
      productId: id,
      reason: "x",
    }),
  ).rejects.toThrow(/Archive it instead/);

  // Became used after the request: approving fails and nothing changes.
  inUse.mockResolvedValue(false);
  const approvalId = await s.t
    .withIdentity({ subject: s.inventory })
    .mutation(api.products.requestDeletion, { productId: id, reason: "x" });
  inUse.mockResolvedValue(true);
  await expect(
    s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
      approvalId,
      decision: "approve",
    }),
  ).rejects.toThrow(/Archive it instead/);
  expect(await getProduct(s, id)).not.toBeNull();
  const approval = await s.t.run((ctx) => ctx.db.get("approvals", approvalId));
  expect(approval!.status).toBe("pending");
});

test("list searches and filters within the service", async () => {
  const s = await setup();
  await create(s, s.chief, { name: "Body wave wig", brand: "Queen" });
  await create(s, s.chief, { name: "Straight bundle", category: "bundles", unit: "bundle" });
  await create(s, s.inventory, { name: "Kinky closure", category: "closures" });
  const fashionId = await getBusinessUnitId(s.t, "fashion");
  await s.t.run((ctx) =>
    ctx.db.insert("products", {
      businessUnitId: fashionId,
      name: "Queen dress",
      sku: "FASH-00001",
      category: "accessories",
      unit: "piece",
      status: "active",
      createdBy: s.chief,
      searchText: "queen dress",
    }),
  );

  const names = async (extra: Record<string, unknown>) =>
    (
      await s.t.withIdentity({ subject: s.chief }).query(api.products.list, {
        businessUnitKey: "hair",
        paginationOpts: PAGE,
        ...extra,
      })
    ).page.map((p) => p.name);

  expect(await names({})).toEqual(["Body wave wig", "Kinky closure", "Straight bundle"]);
  expect(await names({ search: "queen" })).toEqual(["Body wave wig"]);
  expect(await names({ search: "HAIR-00002" })).toEqual(["Straight bundle"]);
  expect(await names({ category: "bundles" })).toEqual(["Straight bundle"]);
  expect(await names({ status: "pending_confirmation" })).toEqual(["Kinky closure"]);
  expect(await names({ search: "closure", status: "active" })).toEqual([]);
});

test("managing products needs products.manage; viewing needs products.view", async () => {
  const s = await setup();
  const nobody = await insertUserWithRole(s.t, null, { email: "none@x.com" });
  const asNobody = s.t.withIdentity({ subject: nobody });
  await expect(create(s, nobody)).rejects.toThrow(/products\.manage/);
  await expect(
    asNobody.query(api.products.list, { businessUnitKey: "hair", paginationOpts: PAGE }),
  ).rejects.toThrow(/products\.view/);
});
