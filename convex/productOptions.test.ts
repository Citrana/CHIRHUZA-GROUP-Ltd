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
  const inventory = await insertUserWithRole(t, "chief_inventory_admin", { email: "inv@x.com" });
  const agent = await insertUserWithRole(t, "sales_agent", {
    email: "a@x.com",
    locationId: await insertLocation(t),
  });
  return { t, asInventory: t.withIdentity({ subject: inventory }), asAgent: t.withIdentity({ subject: agent }) };
}

test("lengths: added once, sorted, deactivated and reactivated, all audited", async () => {
  const { t, asInventory } = await setup();
  await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 24 });
  const twelve = await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 12 });
  await expect(
    asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 12 }),
  ).rejects.toMatchObject({ data: { code: "DUPLICATE" } });
  await expect(
    asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 12.5 }),
  ).rejects.toThrow(/whole number/);

  const inches = async (includeInactive?: boolean) =>
    (await asInventory.query(api.productOptions.listLengths, { businessUnitKey: "hair", includeInactive })).map(
      (l) => l.inches,
    );
  expect(await inches()).toEqual([12, 24]);

  await asInventory.mutation(api.productOptions.setLengthActive, { lengthId: twelve, active: false });
  expect(await inches()).toEqual([24]);
  expect(await inches(true)).toEqual([12, 24]);
  await asInventory.mutation(api.productOptions.setLengthActive, { lengthId: twelve, active: true });

  const audit = await t.run((ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_entityTable_and_timestamp", (q) => q.eq("entityTable", "productLengths"))
      .collect(),
  );
  expect(audit.map((a) => a.action)).toEqual(["create", "create", "update", "update"]);
});

test("colours: duplicates rejected case-insensitively, renamed, deactivated", async () => {
  const { asInventory } = await setup();
  const id = await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: " Natural  black " });
  await expect(
    asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "natural black" }),
  ).rejects.toMatchObject({ data: { code: "DUPLICATE" } });

  await asInventory.mutation(api.productOptions.renameColour, { colourId: id, name: "Jet black" });
  await asInventory.mutation(api.productOptions.setColourActive, { colourId: id, active: false });

  const all = await asInventory.query(api.productOptions.listColours, { businessUnitKey: "hair", includeInactive: true });
  expect(all).toMatchObject([{ name: "Jet black", active: false }]);
  expect(await asInventory.query(api.productOptions.listColours, { businessUnitKey: "hair" })).toEqual([]);
});

test("changing settings needs products.settings; reading needs products.view", async () => {
  const { asAgent } = await setup();
  await expect(
    asAgent.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 18 }),
  ).rejects.toThrow(/products\.settings/);
  // Sales Agents hold products.view, so the product form can list options.
  expect(await asAgent.query(api.productOptions.listLengths, { businessUnitKey: "hair" })).toEqual([]);
});

test("an unused length or colour is deleted and audited", async () => {
  const { t, asInventory } = await setup();
  const lengthId = await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 16 });
  const colourId = await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "Burgundy" });

  await asInventory.mutation(api.productOptions.deleteLength, { lengthId });
  await asInventory.mutation(api.productOptions.deleteColour, { colourId });

  expect(await t.run((ctx) => ctx.db.get("productLengths", lengthId))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get("productColours", colourId))).toBeNull();
  const deletes = await t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.action === "delete"),
  );
  expect(deletes.map((a) => [a.entityTable, a.before])).toEqual([
    ["productLengths", { inches: 16, active: true }],
    ["productColours", { name: "Burgundy", active: true }],
  ]);
});

test("a length or colour used by any product (even archived) can't be deleted", async () => {
  const { t, asInventory } = await setup();
  const lengthId = await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 20 });
  const colourId = await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "Ash" });
  const hairId = (await t.run((ctx) => ctx.db.get("productLengths", lengthId)))!.businessUnitId;
  const creator = (await t.run((ctx) => ctx.db.query("users").first()))!._id;
  await t.run((ctx) =>
    ctx.db.insert("products", {
      businessUnitId: hairId,
      name: "Old wig",
      sku: "HAIR-00001",
      category: "wigs",
      unit: "piece",
      lengthInches: 20,
      colourId,
      status: "archived",
      createdBy: creator,
      searchText: "old wig",
    }),
  );

  await expect(
    asInventory.mutation(api.productOptions.deleteLength, { lengthId }),
  ).rejects.toMatchObject({ data: { code: "IN_USE", count: 1 } });
  await expect(
    asInventory.mutation(api.productOptions.deleteColour, { colourId }),
  ).rejects.toMatchObject({ data: { code: "IN_USE", count: 1 } });
  expect(await t.run((ctx) => ctx.db.get("productLengths", lengthId))).not.toBeNull();

  const lengths = await asInventory.query(api.productOptions.listLengths, { businessUnitKey: "hair" });
  expect(lengths.find((l) => l._id === lengthId)?.productCount).toBe(1);
  const colours = await asInventory.query(api.productOptions.listColours, { businessUnitKey: "hair" });
  expect(colours.find((c) => c._id === colourId)?.productCount).toBe(1);
});

test("deleting settings needs products.settings", async () => {
  const { asInventory, asAgent } = await setup();
  const lengthId = await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 14 });
  await expect(
    asAgent.mutation(api.productOptions.deleteLength, { lengthId }),
  ).rejects.toThrow(/products\.settings/);
});

test("lengths and colours are unique per service, including deactivated ones and spelling variants", async () => {
  const { asInventory } = await setup();
  const lengthId = await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 22 });
  await asInventory.mutation(api.productOptions.setLengthActive, { lengthId, active: false });
  await expect(
    asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "hair", inches: 22 }),
  ).rejects.toMatchObject({ data: { code: "DUPLICATE" } });

  const colourId = await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "Dark Brown" });
  await asInventory.mutation(api.productOptions.setColourActive, { colourId, active: false });
  for (const variant of ["dark brown", "  DARK   brown ", "Dark Brown"]) {
    await expect(
      asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: variant }),
    ).rejects.toMatchObject({ data: { code: "DUPLICATE" } });
  }

  // The same value is fine in another service.
  await asInventory.mutation(api.productOptions.addLength, { businessUnitKey: "fashion", inches: 22 });
  await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "fashion", name: "Dark Brown" });
});

test("renaming can't create a duplicate, but can re-case the same colour", async () => {
  const { asInventory } = await setup();
  await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "1B" });
  const otherId = await asInventory.mutation(api.productOptions.addColour, { businessUnitKey: "hair", name: "Ash blonde" });

  await expect(
    asInventory.mutation(api.productOptions.renameColour, { colourId: otherId, name: " 1b " }),
  ).rejects.toMatchObject({ data: { code: "DUPLICATE" } });

  await asInventory.mutation(api.productOptions.renameColour, { colourId: otherId, name: "ASH BLONDE" });
  const colours = await asInventory.query(api.productOptions.listColours, { businessUnitKey: "hair" });
  expect(colours.map((c) => c.name).sort()).toEqual(["1B", "ASH BLONDE"]);
});
