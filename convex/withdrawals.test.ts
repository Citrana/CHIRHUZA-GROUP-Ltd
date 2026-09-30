import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { insertLocation, insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };
const today = () => businessDayOf(Date.now());

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const shop = await insertLocation(t, { name: "Goma Shop" });
  const other = await insertLocation(t, { name: "Other Shop" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", name: "Agent", locationId: shop });
  const agent2 = await insertUserWithRole(t, "sales_agent", { email: "agent2@x.com", name: "Agent 2", locationId: other });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Manager" });
  const chiefSales = await insertUserWithRole(t, "chief_sales_admin", { email: "cs@x.com", name: "Chief Sales" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com", name: "Owner" });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  return { t, shop, other, agent, agent2, chief, manager, chiefSales, superAdmin, as };
}
type S = Awaited<ReturnType<typeof setup>>;

const request = (
  s: S,
  who: Id<"users">,
  fields: Partial<{ locationId: Id<"locations">; takenBy: Id<"users">; reason: string; date: string; amount: number }> = {},
) =>
  s.as(who).mutation(api.withdrawals.create, {
    businessUnitKey: "hair",
    amount: fields.amount ?? 5_000,
    reason: fields.reason ?? "Family expense",
    ...(fields.locationId ? { locationId: fields.locationId } : {}),
    ...(fields.takenBy ? { takenBy: fields.takenBy } : {}),
    ...(fields.date ? { date: fields.date } : {}),
  });

const approvalOf = async (s: S, id: Id<"withdrawals">) => (await s.t.run((ctx) => ctx.db.get("withdrawals", id)))!.approvalId!;
const decide = (s: S, who: Id<"users">, id: Id<"withdrawals">, decision: "approve" | "reject") =>
  approvalOf(s, id).then((approvalId) => s.as(who).mutation(api.approvals.decideApproval, { approvalId, decision }));
const totals = (s: S, who: Id<"users">, filters: Partial<{ locationId: Id<"locations">; from: string; to: string }> = {}) =>
  s.as(who).query(api.withdrawals.totals, { businessUnitKey: "hair", ...filters });

test("a withdrawal is requested, then approved by the Chief Admin only", async () => {
  const s = await setup();
  const id = await request(s, s.agent, { amount: 7_500 });
  expect(await s.t.run((ctx) => ctx.db.get("withdrawals", id))).toMatchObject({
    locationId: s.shop,
    takenBy: s.agent,
    requestedBy: s.agent,
    status: "pending",
    currency: "USD",
  });

  // Nobody but the Chief Admin (and Super Admin) holds withdrawals.approve now.
  for (const who of [s.agent2, s.manager, s.chiefSales]) {
    await expect(decide(s, who, id, "approve")).rejects.toThrow(/withdrawals\.approve/);
  }
  expect(await totals(s, s.chief)).toMatchObject({ approved: 0, pending: 7_500 });
  await decide(s, s.chief, id, "approve");
  expect(await totals(s, s.chief)).toMatchObject({ approved: 7_500, pending: 0 });

  const audits = await s.t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(
    audits.filter((a) => a.entityTable === "withdrawals").map((a) => [a.action, (a.after as { status?: string }).status]),
  ).toEqual([
    ["create", "pending"],
    ["update", "approved"],
  ]);
});

test("the requester can't approve their own; the Super Admin can (flagged); rejection", async () => {
  const s = await setup();
  const chiefs = await request(s, s.chief, { reason: "Personal" });
  await expect(decide(s, s.chief, chiefs, "approve")).rejects.toThrow(/own request/);
  await decide(s, s.superAdmin, chiefs, "reject");
  expect((await s.t.run((ctx) => ctx.db.get("withdrawals", chiefs)))!.status).toBe("rejected");

  const owner = await request(s, s.superAdmin, { reason: "Owner draw" });
  await decide(s, s.superAdmin, owner, "approve");
  const approvalId = await approvalOf(s, owner);
  const decision = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).find((a) => a.entityTable === "approvals" && a.entityId === approvalId && a.action === "approve"),
  );
  expect(decision!.after).toMatchObject({ selfApproved: true });
});

test("location lock, list scope, date filters and validation", async () => {
  const s = await setup();
  await expect(request(s, s.agent, { locationId: s.other })).rejects.toThrow(/only use your own location/);
  const yesterday = addBusinessDays(today(), -1);
  await request(s, s.agent, { date: yesterday, amount: 1_000 });
  await request(s, s.agent2, { amount: 2_000 });
  // A chief can take from any till, or business-level cash (no location), for someone else.
  await request(s, s.chief, { locationId: s.other, takenBy: s.superAdmin, amount: 3_000 });
  await request(s, s.chief, { amount: 4_000 });

  const list = (who: Id<"users">, filters: Partial<{ locationId: Id<"locations">; from: string; to: string }> = {}) =>
    s.as(who).query(api.withdrawals.list, { businessUnitKey: "hair", paginationOpts: PAGE, ...filters });
  // The agent (own_location) sees only Goma Shop's.
  expect((await list(s.agent)).page.map((w) => w.amount)).toEqual([1_000]);
  expect((await list(s.agent, { locationId: s.other })).page.map((w) => w.amount)).toEqual([1_000]);
  // The chief sees all four; by location; by business day.
  expect((await list(s.chief)).page).toHaveLength(4);
  const otherShop = (await list(s.chief, { locationId: s.other })).page;
  expect(otherShop.map((w) => [w.amount, w.takenByName, w.requestedByName])).toEqual([
    [3_000, "Owner", "Chief"],
    [2_000, "Agent 2", "Agent 2"],
  ]);
  expect((await list(s.chief, { from: yesterday, to: yesterday })).page.map((w) => w.amount)).toEqual([1_000]);
  expect((await totals(s, s.chief, { from: today(), to: today() })).pending).toBe(9_000);

  // Validation.
  await expect(request(s, s.agent, { reason: " " })).rejects.toThrow(/reason/);
  await expect(request(s, s.agent, { date: addBusinessDays(today(), 1) })).rejects.toThrow(/future/);
  await expect(request(s, s.agent, { date: "2026-02-30" })).rejects.toThrow(/YYYY-MM-DD/);
  await expect(request(s, s.agent, { amount: -5 })).rejects.toThrow(/cents above 0/);
  await expect(list(s.chief, { from: "yesterday" })).rejects.toThrow(/YYYY-MM-DD/);
});

test("withdrawals stay out of sales: the sales list and totals don't include them", async () => {
  const s = await setup();
  const id = await request(s, s.chief, { amount: 50_000 });
  await decide(s, s.superAdmin, id, "approve");
  const sales = await s.as(s.chief).query(api.sales.list, { businessUnitKey: "hair", paginationOpts: PAGE });
  expect(sales.page).toEqual([]);
});
