import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ALL } from "./lib/analytics";
import { weekdayOf } from "./lib/salesDays";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { getBusinessUnitId, insertLocation, insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * Shop A (open every day) sold 10 days ago and 3 days ago; shop B never
 * sold; a warehouse. Users: the Super Admin, a Chief Admin (analytics, no
 * sales.create) and a sales agent at shop B.
 */
async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const hairId = await getBusinessUnitId(t, "hair");
  const shopA = await insertLocation(t, { name: "A Shop" });
  const shopB = await insertLocation(t, { name: "B Shop" });
  await insertLocation(t, { name: "Depot", type: "warehouse" });
  await t.run(async (ctx) => {
    await ctx.db.patch("locations", shopA, { openDays: EVERY_DAY });
    await ctx.db.patch("locations", shopB, { openDays: EVERY_DAY });
  });
  const today = businessDayOf(Date.now());
  const day = (n: number) => addBusinessDays(today, n);
  // The rollups a sale would leave (tests may write them directly).
  await t.run(async (ctx) => {
    for (const d of [day(-10), day(-3)]) {
      for (const locationKey of [shopA, ALL]) {
        await ctx.db.insert("dailyFinance", {
          businessUnitId: hairId, locationKey, day: d, sales: 500, saleCost: 200, expenses: 0, payroll: 0, withdrawals: 0,
        });
      }
    }
  });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com" });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", locationId: shopB });
  const as = (id: Id<"users">) => t.withIdentity({ subject: id });
  const range = { from: day(-10), to: today };
  const salesDays = (who: Id<"users">, locationId?: Id<"locations">) =>
    as(who).query(api.analytics.getSalesDays, { businessUnitKey: "hair", range, ...(locationId ? { locationId } : {}) });
  return { t, hairId, shopA, shopB, superAdmin, chief, agent, as, day, today, salesDays };
}

test("missing days: past open days of shops since their first sale, recent first", async () => {
  const s = await setup();
  const result = await s.salesDays(s.superAdmin);
  // -9..-1 except -3 (sold); shop B never sold; the warehouse isn't tracked; today never.
  expect(result.missing.map((m) => [m.name, m.day])).toEqual(
    [-1, -2, -4, -5, -6, -7, -8, -9].map((n) => ["A Shop", s.day(n)]),
  );
  expect(result.missing.every((m) => m.canMark)).toBe(true);
  const byDay = new Map(result.days.map((d) => [d.day, d]));
  expect(byDay.get(s.day(-1))).toMatchObject({ missing: true, closed: false });
  expect(byDay.get(s.day(-3))).toMatchObject({ missing: false });
  expect(byDay.get(s.today)).toMatchObject({ missing: false });

  // Without sales.create the days are shown but can't be marked.
  expect((await s.salesDays(s.chief)).missing.every((m) => !m.canMark)).toBe(true);
  // Without analytics.view: refused.
  await expect(s.salesDays(s.agent)).rejects.toThrow();
});

test("mark closed / no sales, undo and mark again - each audited", async () => {
  const s = await setup();
  const target = { businessUnitKey: "hair" as const, locationId: s.shopA, day: s.day(-2) };
  const id = await s.as(s.superAdmin).mutation(api.salesDays.markClosed, { ...target, note: "  Public holiday " });

  let result = await s.salesDays(s.superAdmin);
  expect(result.missing.map((m) => m.day)).not.toContain(s.day(-2));
  expect(result.marked).toEqual([{ locationId: s.shopA, name: "A Shop", day: s.day(-2), note: "Public holiday", canMark: true }]);
  await expect(s.as(s.superAdmin).mutation(api.salesDays.markClosed, target)).rejects.toThrow(/already marked/);

  await s.as(s.superAdmin).mutation(api.salesDays.clearClosed, target);
  result = await s.salesDays(s.superAdmin);
  expect(result.missing.map((m) => m.day)).toContain(s.day(-2));
  expect(result.marked).toEqual([]);
  await expect(s.as(s.superAdmin).mutation(api.salesDays.clearClosed, target)).rejects.toThrow(/isn't marked/);

  // Marked again: the same row comes back (never deleted).
  expect(await s.as(s.superAdmin).mutation(api.salesDays.markClosed, target)).toBe(id);
  const rows = await s.t.run((ctx) => ctx.db.query("closedSalesDays").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].active).toBe(true);
  expect(rows[0]).not.toHaveProperty("note");
  expect(rows[0]).not.toHaveProperty("clearedAt");

  const audit = await s.t.run((ctx) => ctx.db.query("auditLogs").collect());
  const entries = audit.filter((a) => a.entityTable === "closedSalesDays");
  expect(entries.map((a) => a.action)).toEqual(["create", "update", "update"]);
  expect(entries[0].after).toMatchObject({ day: s.day(-2), locationName: "A Shop", note: "Public holiday", active: true });
  expect(entries[1]).toMatchObject({ before: { active: true }, after: { active: false, locationName: "A Shop" } });
});

test("only past open days with no sales, in the caller's own location scope", async () => {
  const s = await setup();
  const mark = (who: Id<"users">, locationId: Id<"locations">, day: string) =>
    s.as(who).mutation(api.salesDays.markClosed, { businessUnitKey: "hair", locationId, day });
  await expect(mark(s.superAdmin, s.shopA, s.day(-3))).rejects.toThrow(/already has sales/);
  await expect(mark(s.superAdmin, s.shopA, s.today)).rejects.toThrow(/past days/);
  await expect(mark(s.superAdmin, s.shopA, s.day(1))).rejects.toThrow(/past days/);
  await expect(mark(s.superAdmin, s.shopA, "2026-13-01")).rejects.toThrow();
  // A seller (own_location) marks only their own shop; no sales.create: refused.
  await expect(mark(s.agent, s.shopA, s.day(-2))).rejects.toThrow();
  await mark(s.agent, s.shopB, s.day(-2));
  await expect(mark(s.chief, s.shopA, s.day(-2))).rejects.toThrow();

  // A weekday the shop doesn't open: never flagged, can't be marked.
  const weekday = weekdayOf(s.day(-4));
  await s.t.run((ctx) => ctx.db.patch("locations", s.shopA, { openDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday) }));
  await expect(mark(s.superAdmin, s.shopA, s.day(-4))).rejects.toThrow(/doesn't open/);
  const result = await s.salesDays(s.superAdmin, s.shopA);
  expect(result.missing.map((m) => m.day)).not.toContain(s.day(-4));
  expect(result.days.find((d) => d.day === s.day(-4))).toMatchObject({ closed: true, missing: false });
});

test("Home counts this month's missing days in the caller's scope", async () => {
  const s = await setup();
  const home = (who: Id<"users">) => s.as(who).query(api.home.summary, { businessUnitKey: "hair" });
  const month = await s.as(s.superAdmin).query(api.analytics.getSalesDays, { businessUnitKey: "hair", range: { preset: "month" } });
  expect((await home(s.superAdmin)).missingSalesDays).toEqual({ count: month.missing.length });
  // The agent's own shop never sold: nothing to flag there.
  expect((await home(s.agent)).missingSalesDays).toEqual({ count: 0 });
});
