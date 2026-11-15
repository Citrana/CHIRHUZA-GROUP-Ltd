import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  insertLocation,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  return { t, asAdmin: t.withIdentity({ subject: adminId }), adminId };
}

test("a Super Admin creates and edits a location, each change audited", async () => {
  const { t, asAdmin, adminId } = await setup();

  const locationId = await asAdmin.mutation(api.locations.create, {
    name: "  Kenya Shop  ",
    type: "shop",
    address: "Av. Kasai 12",
    active: true,
  });
  await asAdmin.mutation(api.locations.update, {
    locationId,
    name: "Kenya Shop",
    type: "shop",
    address: "Av. Kasai 14",
    active: false,
  });

  const location = await t.run((ctx) => ctx.db.get("locations", locationId));
  expect(location).toMatchObject({
    name: "Kenya Shop",
    address: "Av. Kasai 14",
    active: false,
  });

  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs.map((l) => l.action)).toEqual(["create", "update"]);
  expect(logs[0]).toMatchObject({
    actorId: adminId,
    entityTable: "locations",
    entityId: locationId,
    after: { name: "Kenya Shop", type: "shop", active: true },
  });
  // Locations are global: shared by every service, not tied to one.
  expect(location!.businessUnitId).toBeUndefined();
  expect(logs[0].businessUnitId).toBeUndefined();
  expect(logs[0].before).toBeUndefined();
  // Updates record only the changed fields.
  expect(logs[1]).toMatchObject({
    action: "update",
    before: { address: "Av. Kasai 12", active: true },
    after: { address: "Av. Kasai 14", active: false },
  });
  expect(Object.keys(logs[1].after!).sort()).toEqual(["active", "address"]);
});

test("an update with no changes writes no audit entry", async () => {
  const { t, asAdmin } = await setup();
  const locationId = await insertLocation(t, { name: "Same" });
  await asAdmin.mutation(api.locations.update, {
    locationId,
    name: "Same",
    type: "shop",
    address: "1 Test Avenue",
    active: true,
  });
  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs).toHaveLength(0);
});

test("location management is rejected without locations.manage", async () => {
  const { t } = await setup();
  const agentId = await insertUserWithRole(t, "sales_agent", {
    email: "g@x.com",
    locationId: await insertLocation(t),
  });
  const asAgent = t.withIdentity({ subject: agentId });

  await expect(
    asAgent.mutation(api.locations.create, {
      name: "Nope",
      type: "shop",
      address: "",
      active: true,
    }),
  ).rejects.toThrow(/locations\.manage/);
  await expect(
    asAgent.query(api.locations.list, {}),
  ).rejects.toThrow(/locations\.manage/);
});

test("create rejects a blank name", async () => {
  const { asAdmin } = await setup();
  await expect(
    asAdmin.mutation(api.locations.create, {
      name: "   ",
      type: "warehouse",
      address: "",
      active: true,
    }),
  ).rejects.toThrow(/name is required/);
});

test("list returns every location (shared by all services); listOptions only active ones", async () => {
  const { t, asAdmin } = await setup();
  await insertLocation(t, { name: "B shop" });
  await insertLocation(t, { name: "A closed", active: false });
  await insertLocation(t, { name: "C warehouse", type: "warehouse" });

  const all = await asAdmin.query(api.locations.list, {});
  expect(all.map((l) => l.name)).toEqual(["A closed", "B shop", "C warehouse"]);

  const options = await asAdmin.query(api.locations.listOptions, {});
  expect(options.map((o) => o.name)).toEqual(["B shop", "C warehouse"]);
});

test("open days: Monday to Saturday by default, cleaned, audited when changed", async () => {
  const { t, asAdmin } = await setup();
  const fields = { name: "Shop", type: "shop" as const, address: "", active: true };
  const locationId = await asAdmin.mutation(api.locations.create, fields);
  expect((await t.run((ctx) => ctx.db.get("locations", locationId)))?.openDays).toEqual([1, 2, 3, 4, 5, 6]);

  await asAdmin.mutation(api.locations.update, { locationId, ...fields, openDays: [0, 6, 6, 1] });
  expect((await t.run((ctx) => ctx.db.get("locations", locationId)))?.openDays).toEqual([0, 1, 6]);
  await expect(asAdmin.mutation(api.locations.update, { locationId, ...fields, openDays: [] })).rejects.toThrow();
  await expect(asAdmin.mutation(api.locations.update, { locationId, ...fields, openDays: [7] })).rejects.toThrow();
  // Left out: unchanged, and no audit entry.
  await asAdmin.mutation(api.locations.update, { locationId, ...fields });

  const updates = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter(
    (a) => a.entityTable === "locations" && a.action === "update",
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ before: { openDays: [1, 2, 3, 4, 5, 6] }, after: { openDays: [0, 1, 6] } });
});
