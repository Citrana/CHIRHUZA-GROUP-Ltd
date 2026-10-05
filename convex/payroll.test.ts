import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { addMonths, isPeriod } from "./lib/payroll";
import { businessDayOf } from "./lib/time";
import { insertLocation, insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };
const thisMonth = () => businessDayOf(Date.now()).slice(0, 7);

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const shop = await insertLocation(t, { name: "Goma Shop" });
  const other = await insertLocation(t, { name: "Other Shop" });
  const agent = await insertUserWithRole(t, "sales_agent", { email: "agent@x.com", name: "Agent", locationId: shop });
  const agent2 = await insertUserWithRole(t, "sales_agent", { email: "agent2@x.com", name: "Agent 2", locationId: other });
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const chief2 = await insertUserWithRole(t, "chief_admin", { email: "chief2@x.com", name: "Chief 2" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Manager" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com", name: "Super" });
  const nobody = await insertUserWithRole(t, null, { email: "none@x.com" });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  return { t, shop, other, agent, agent2, chief, chief2, manager, superAdmin, nobody, as };
}
type S = Awaited<ReturnType<typeof setup>>;

const submit = (
  s: S,
  who: Id<"users">,
  fields: Partial<{ locationId: Id<"locations">; userId: Id<"users">; workerName: string; period: string; amount: number; note: string }> = {},
) =>
  s.as(who).mutation(api.payroll.create, {
    businessUnitKey: "hair",
    period: fields.period ?? thisMonth(),
    amount: fields.amount ?? 15_000,
    ...(fields.userId ? { userId: fields.userId } : { workerName: fields.workerName ?? "Neema" }),
    ...(fields.locationId ? { locationId: fields.locationId } : {}),
    ...(fields.note ? { note: fields.note } : {}),
  });

const approvalOf = async (s: S, id: Id<"payrollEntries">) => (await s.t.run((ctx) => ctx.db.get("payrollEntries", id)))!.approvalId!;
const statusOf = async (s: S, id: Id<"payrollEntries">) => (await s.t.run((ctx) => ctx.db.get("payrollEntries", id)))!.status;
const list = (s: S, who: Id<"users">, filters: Partial<{ locationId: Id<"locations">; fromPeriod: string; toPeriod: string }> = {}) =>
  s.as(who).query(api.payroll.list, { businessUnitKey: "hair", paginationOpts: PAGE, ...filters });

test("anyone submits; an agent is locked to their location and sees only their own entries", async () => {
  const s = await setup();
  const mine = await submit(s, s.agent, { workerName: "Neema", note: "September" });
  const entry = await s.t.run((ctx) => ctx.db.get("payrollEntries", mine));
  expect(entry).toMatchObject({ locationId: s.shop, workerName: "Neema", status: "pending", currency: "USD", createdBy: s.agent });
  await expect(submit(s, s.agent, { locationId: s.other })).rejects.toThrow(/only use your own location/);

  // Another agent's entry and a chief's entry: the agent sees only theirs.
  await submit(s, s.agent2, { workerName: "Jean" });
  await submit(s, s.manager, { userId: s.agent, locationId: s.shop });
  expect((await list(s, s.agent)).page.map((e) => e.workerName)).toEqual(["Neema"]);
  expect((await s.as(s.agent).query(api.payroll.totals, { businessUnitKey: "hair" })).ownOnly).toBe(true);

  // The Chief Admin (payroll.view) sees all three; a user named by id gets their name.
  const all = (await list(s, s.chief)).page;
  expect(all.map((e) => e.workerName).sort()).toEqual(["Agent", "Jean", "Neema"]);
  expect(all.find((e) => e.workerName === "Neema")).toMatchObject({ locationName: "Goma Shop", createdByName: "Agent" });

  // No payroll permission at all.
  await expect(submit(s, s.nobody)).rejects.toThrow(/payroll\.create/);
  await expect(list(s, s.nobody)).rejects.toThrow(/payroll\.create/);
});

test("the Chief Admin approves - never their own entry; the Super Admin's self-approval is flagged", async () => {
  const s = await setup();
  const agentEntry = await submit(s, s.agent);
  // An agent can't approve payroll.
  await expect(
    s.as(s.agent2).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, agentEntry), decision: "approve" }),
  ).rejects.toThrow(/payroll\.approve/);
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, agentEntry), decision: "approve" });
  expect(await statusOf(s, agentEntry)).toBe("approved");

  // The Chief Admin adds payroll too, but can't approve it themselves.
  const chiefEntry = await submit(s, s.chief, { workerName: "Guard" });
  await expect(
    s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, chiefEntry), decision: "approve" }),
  ).rejects.toThrow(/own request/);
  await s.as(s.chief2).mutation(api.approvals.decideApproval, {
    approvalId: await approvalOf(s, chiefEntry),
    decision: "reject",
    note: "Wrong month",
  });
  expect(await statusOf(s, chiefEntry)).toBe("rejected");
  const rejected = (await list(s, s.chief)).page.find((e) => e._id === chiefEntry);
  expect(rejected).toMatchObject({ decidedByName: "Chief 2", decisionNote: "Wrong month" });

  // The Super Admin may approve their own (flagged).
  const saEntry = await submit(s, s.superAdmin, { workerName: "Driver" });
  const saApproval = await approvalOf(s, saEntry);
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId: saApproval, decision: "approve" });
  const audits = await s.t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(audits.find((a) => a.entityTable === "approvals" && a.entityId === saApproval && a.action === "approve")!.after).toMatchObject({
    selfApproved: true,
  });
  // Every status change is audited on the entry itself.
  expect(
    audits.filter((a) => a.entityTable === "payrollEntries").map((a) => [a.action, (a.after as { status?: string }).status]),
  ).toEqual([
    ["create", "pending"],
    ["update", "approved"],
    ["create", "pending"],
    ["update", "rejected"],
    ["create", "pending"],
    ["update", "approved"],
  ]);
});

test("filters and totals by period and location", async () => {
  const s = await setup();
  const last = addMonths(thisMonth(), -1);
  const a = await submit(s, s.agent, { amount: 10_000, period: last });
  await submit(s, s.agent2, { amount: 20_000 });
  await submit(s, s.agent, { amount: 5_000 });
  await s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId: await approvalOf(s, a), decision: "approve" });

  expect((await list(s, s.chief, { fromPeriod: last, toPeriod: last })).page.map((e) => e.amount)).toEqual([10_000]);
  expect((await list(s, s.chief, { locationId: s.shop })).page.map((e) => e.amount).sort()).toEqual([10_000, 5_000].sort());
  expect(await s.as(s.chief).query(api.payroll.totals, { businessUnitKey: "hair" })).toMatchObject({
    approved: 10_000,
    pending: 25_000,
    currency: "USD",
  });
  expect(await s.as(s.chief).query(api.payroll.totals, { businessUnitKey: "hair", locationId: s.other })).toMatchObject({
    approved: 0,
    pending: 20_000,
  });
  await expect(list(s, s.chief, { fromPeriod: "2026-13" })).rejects.toThrow(/YYYY-MM/);
});

test("validation: worker, period, amount, location", async () => {
  const s = await setup();
  await expect(submit(s, s.chief, { workerName: "  " })).rejects.toThrow(/who is paid/);
  await expect(submit(s, s.chief, { period: "2026-9" })).rejects.toThrow(/YYYY-MM/);
  await expect(submit(s, s.chief, { period: addMonths(thisMonth(), 2) })).rejects.toThrow(/a month ahead/);
  await submit(s, s.chief, { period: addMonths(thisMonth(), 1) });
  await expect(submit(s, s.chief, { amount: 0 })).rejects.toThrow(/cents above 0/);
  await expect(submit(s, s.chief, { amount: 12.5 })).rejects.toThrow(/cents above 0/);
  const closed = await insertLocation(s.t, { name: "Closed", active: false });
  await expect(submit(s, s.chief, { locationId: closed })).rejects.toThrow(/active location/);
  // A chief may leave the location empty (business-level payroll).
  const id = await submit(s, s.chief);
  expect((await s.t.run((ctx) => ctx.db.get("payrollEntries", id)))!.locationId).toBeUndefined();
});

test("isPeriod and addMonths", () => {
  expect(isPeriod("2026-09")).toBe(true);
  expect(isPeriod("2026-13")).toBe(false);
  expect(isPeriod("2026-9")).toBe(false);
  expect(addMonths("2026-12", 1)).toBe("2027-01");
  expect(addMonths("2026-01", -1)).toBe("2025-12");
});
