import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

test("seedBusinessUnits is idempotent and enables Hair and Mode (fashion)", async () => {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  await t.mutation(internal.businessUnits.seedBusinessUnits, {});

  const units = await t.run((ctx) => ctx.db.query("businessUnits").collect());
  expect(units).toHaveLength(4);
  expect(units.filter((u) => u.enabled).map((u) => u.key)).toEqual(["hair", "fashion"]);
});

test("seedBusinessUnits never overwrites an existing unit's enabled flag", async () => {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  await t.run(async (ctx) => {
    const housing = await ctx.db
      .query("businessUnits")
      .withIndex("by_key", (q) => q.eq("key", "housing"))
      .unique();
    await ctx.db.patch("businessUnits", housing!._id, { enabled: true });
  });

  await t.mutation(internal.businessUnits.seedBusinessUnits, {});

  const housing = await t.run((ctx) =>
    ctx.db
      .query("businessUnits")
      .withIndex("by_key", (q) => q.eq("key", "housing"))
      .unique(),
  );
  expect(housing?.enabled).toBe(true);
});

test("setEnabled switches a service on or off", async () => {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const enabled = async (key: string) =>
    (await t.run((ctx) => ctx.db.query("businessUnits").collect())).find((u) => u.key === key)!.enabled;
  await t.mutation(internal.businessUnits.setEnabled, { key: "fashion", enabled: false });
  expect(await enabled("fashion")).toBe(false);
  await t.mutation(internal.businessUnits.setEnabled, { key: "fashion", enabled: true });
  expect(await enabled("fashion")).toBe(true);
});

test("list returns the four units in order to any signed-in user, and rejects anonymous callers", async () => {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const agentId = await insertUserWithRole(t, "chief_admin", { email: "c@x.com" });

  const units = await t
    .withIdentity({ subject: agentId })
    .query(api.businessUnits.list, {});
  expect(units.map((u) => [u.key, u.enabled])).toEqual([
    ["hair", true],
    ["fashion", true],
    ["housing", false],
    ["transport", false],
  ]);

  await expect(t.query(api.businessUnits.list, {})).rejects.toThrow(
    /Not authenticated/,
  );
});
