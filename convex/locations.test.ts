import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  getBusinessUnitId,
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
  const hairId = await getBusinessUnitId(t, "hair");

  const locationId = await asAdmin.mutation(api.locations.create, {
    businessUnitId: hairId,
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
    businessUnitId: hairId,
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
    businessUnitId: hairId,
    after: { businessUnit: "hair", name: "Kenya Shop", type: "shop", active: true },
  });
  expect(logs[0].before).toBeUndefined();
  // Updates record only the changed fields.
  expect(logs[1]).toMatchObject({
    action: "update",
    businessUnitId: hairId,
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
  const hairId = await getBusinessUnitId(t, "hair");
  const agentId = await insertUserWithRole(t, "sales_agent", {
    email: "g@x.com",
    locationId: await insertLocation(t),
  });
  const asAgent = t.withIdentity({ subject: agentId });

  await expect(
    asAgent.mutation(api.locations.create, {
      businessUnitId: hairId,
      name: "Nope",
      type: "shop",
      address: "",
      active: true,
    }),
  ).rejects.toThrow(/locations\.manage/);
  await expect(
    asAgent.query(api.locations.list, { businessUnitId: hairId }),
  ).rejects.toThrow(/locations\.manage/);
});

test("create rejects a blank name", async () => {
  const { t, asAdmin } = await setup();
  await expect(
    asAdmin.mutation(api.locations.create, {
      businessUnitId: await getBusinessUnitId(t, "hair"),
      name: "   ",
      type: "warehouse",
      address: "",
      active: true,
    }),
  ).rejects.toThrow(/name is required/);
});

test("list is scoped to one business unit; listOptions returns only active locations", async () => {
  const { t, asAdmin } = await setup();
  await insertLocation(t, { name: "B hair", businessUnit: "hair" });
  await insertLocation(t, { name: "A hair", businessUnit: "hair", active: false });
  await insertLocation(t, { name: "Fashion shop", businessUnit: "fashion" });

  const hair = await asAdmin.query(api.locations.list, {
    businessUnitId: await getBusinessUnitId(t, "hair"),
  });
  expect(hair.map((l) => l.name)).toEqual(["A hair", "B hair"]);

  const options = await asAdmin.query(api.locations.listOptions, {});
  expect(options.map((o) => [o.name, o.businessUnitKey])).toEqual([
    ["B hair", "hair"],
    ["Fashion shop", "fashion"],
  ]);
});
