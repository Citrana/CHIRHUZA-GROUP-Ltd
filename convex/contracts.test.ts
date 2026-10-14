import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { appendOnlyGuardedDb } from "./lib/rbac";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { daysOverlap, endDay, spreadOverDays } from "./lib/transport";
import { insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };
const today = () => businessDayOf(Date.now());

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Manager" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com", name: "Owner" });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  const unit = "transport" as const;
  const jean = await as(chief).mutation(api.drivers.create, { businessUnitKey: unit, name: "Jean" });
  const car = await as(chief).mutation(api.cars.create, { businessUnitKey: unit, plateNumber: "5432 AB 07", model: "Land Cruiser", driverId: jean });
  const car2 = await as(chief).mutation(api.cars.create, { businessUnitKey: unit, plateNumber: "1111 AA 01", model: "Land Cruiser" });
  const mining = await as(chief).mutation(api.clients.create, { businessUnitKey: unit, kind: "company", name: "Kamoto Mining" });
  return { t, chief, manager, superAdmin, as, jean, car, car2, mining };
}
type S = Awaited<ReturnType<typeof setup>>;

type ContractInput = Partial<{
  carId: Id<"cars">;
  startDay: string;
  days: number;
  dayRate: number;
  agreedTotal: number;
  priceChangeReason: string;
  driverDayRate: number;
  firstPayment: { amount: number; method: "cash" | "mobile_money" | "bank"; paidOn?: string };
}>;
const createContract = (s: S, fields: ContractInput = {}, who = s.chief) =>
  s.as(who).mutation(api.contracts.create, {
    businessUnitKey: "transport",
    carId: fields.carId ?? s.car,
    clientId: s.mining,
    startDay: fields.startDay ?? today(),
    days: fields.days ?? 19,
    dayRate: fields.dayRate ?? 15_000,
    driverDayRate: fields.driverDayRate ?? 2_000,
    ...(fields.agreedTotal !== undefined ? { agreedTotal: fields.agreedTotal } : {}),
    ...(fields.priceChangeReason ? { priceChangeReason: fields.priceChangeReason } : {}),
    ...(fields.firstPayment ? { firstPayment: fields.firstPayment } : {}),
  });
const getContract = (s: S, id: Id<"contracts">) => s.as(s.chief).query(api.contracts.get, { contractId: id });
const clientBalance = async (s: S) => (await s.t.run((ctx) => ctx.db.get("clients", s.mining)))!.balance;

/** The "*" finance rows, day -> sales, and whether they match a rebuild. */
const salesByDay = (s: S) =>
  s.t.run(async (ctx) => {
    const rows = (await ctx.db.query("dailyFinance").collect()).filter((r) => r.locationKey === "*");
    return Object.fromEntries(rows.map((r) => [r.day, r.sales]));
  });
const rollups = (s: S) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("dailyFinance").collect())
      .map(({ _id, _creationTime, ...rest }) => {
        void _id;
        void _creationTime;
        return JSON.stringify(rest);
      })
      .sort(),
  );
async function expectRollupsMatchRebuild(s: S) {
  const incremental = await rollups(s);
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "transport" });
  expect(await rollups(s)).toEqual(incremental);
}

test("helpers: end day, overlap, spreading a total over days", () => {
  expect(endDay("2026-10-14", 19)).toBe("2026-11-01");
  expect(endDay("2026-10-14", 1)).toBe("2026-10-14");
  expect(() => endDay("2026-10-14", 0)).toThrow(/1 to 366 days/);
  expect(daysOverlap({ startDay: "2026-10-01", endDay: "2026-10-05" }, { startDay: "2026-10-05", endDay: "2026-10-09" })).toBe(true);
  expect(daysOverlap({ startDay: "2026-10-01", endDay: "2026-10-05" }, { startDay: "2026-10-06", endDay: "2026-10-09" })).toBe(false);
  expect(spreadOverDays(1000, 3)).toEqual([334, 333, 333]);
  expect(spreadOverDays(-1000, 3)).toEqual([-334, -333, -333]);
  expect(spreadOverDays(285_000, 19).reduce((a, b) => a + b, 0)).toBe(285_000);
});

test("a contract: price per day × days, the car's driver, revenue spread over its days", async () => {
  const s = await setup();
  const start = "2026-10-01";
  const { contractId, number } = await createContract(s, { startDay: start, days: 3, dayRate: 10_000, driverDayRate: 2_500 });
  expect(number).toBe("CONTRACT-00001");
  expect(await getContract(s, contractId)).toMatchObject({
    plateNumber: "5432 AB 07",
    clientName: "Kamoto Mining",
    driverName: "Jean",
    endDay: "2026-10-03",
    computedTotal: 30_000,
    totalAmount: 30_000,
    driverPayTotal: 7_500,
    amountPaid: 0,
    balance: 30_000,
    paymentStatus: "open",
  });
  expect(await clientBalance(s)).toBe(30_000);
  expect(await salesByDay(s)).toEqual({ "2026-10-01": 10_000, "2026-10-02": 10_000, "2026-10-03": 10_000 });
  await expectRollupsMatchRebuild(s);

  // The cars list shows it running on its days.
  const cars = await s.as(s.chief).query(api.cars.list, { businessUnitKey: "transport", today: "2026-10-02" });
  expect(cars.find((c) => c._id === s.car)?.currentContract).toMatchObject({ number, endDay: "2026-10-03" });
  const later = await s.as(s.chief).query(api.cars.list, { businessUnitKey: "transport", today: "2026-10-04" });
  expect(later.find((c) => c._id === s.car)?.currentContract).toBeNull();
});

test("rules: no overlap on one car, a retired car or a changed total without reason is refused", async () => {
  const s = await setup();
  await createContract(s, { startDay: "2026-10-01", days: 19 });
  await expect(createContract(s, { startDay: "2026-10-19", days: 2 })).rejects.toThrow(/already hired from 2026-10-01 to 2026-10-19/);
  await createContract(s, { startDay: "2026-10-20", days: 2 });
  await createContract(s, { carId: s.car2, startDay: "2026-10-05", days: 2 });
  await expect(createContract(s, { agreedTotal: 100_000, startDay: "2026-12-01" })).rejects.toThrow(/Say why the total differs/);
  const { contractId } = await createContract(s, {
    startDay: "2026-12-01",
    days: 10,
    dayRate: 15_000,
    agreedTotal: 140_000,
    priceChangeReason: "Long-term client discount",
  });
  expect(await getContract(s, contractId)).toMatchObject({ computedTotal: 150_000, totalAmount: 140_000, priceChangeReason: "Long-term client discount" });

  await s.as(s.chief).mutation(api.cars.update, { carId: s.car2, plateNumber: "1111 AA 01", model: "Land Cruiser", driverId: null, status: "retired" });
  await expect(createContract(s, { carId: s.car2, startDay: "2027-01-01" })).rejects.toThrow(/retired/);
  // Permissions.
  await expect(createContract(s, { startDay: "2027-02-01" }, s.manager)).rejects.toThrow(/transport\.contracts\.manage/);
  await expect(s.as(s.manager).query(api.contracts.list, { businessUnitKey: "transport", paginationOpts: PAGE })).rejects.toThrow(/transport\.view/);
});

test("client payments: at signing and later, never more than owed, settled at the end", async () => {
  const s = await setup();
  const { contractId } = await createContract(s, { days: 2, dayRate: 10_000, firstPayment: { amount: 5_000, method: "cash" } });
  expect(await getContract(s, contractId)).toMatchObject({ amountPaid: 5_000, balance: 15_000, paymentStatus: "open" });
  expect(await clientBalance(s)).toBe(15_000);

  const pay = (amount: number, paidOn?: string) =>
    s.as(s.chief).mutation(api.contractPayments.add, { contractId, amount, method: "bank", ...(paidOn ? { paidOn } : {}) });
  await expect(pay(20_000)).rejects.toThrow(/more than the client still owes/);
  await expect(pay(1_000, addBusinessDays(today(), 1))).rejects.toThrow(/future/);
  await pay(10_000, addBusinessDays(today(), -3));
  await pay(5_000);
  const contract = await getContract(s, contractId);
  expect(contract).toMatchObject({ amountPaid: 20_000, balance: 0, paymentStatus: "settled" });
  expect(contract!.payments.map((p) => [p.amount, p.method])).toEqual([
    [5_000, "bank"],
    [5_000, "cash"],
    [10_000, "bank"],
  ]);
  expect(await clientBalance(s)).toBe(0);
  // Payments never touch the rollups.
  await expectRollupsMatchRebuild(s);

  await expect(pay(0)).rejects.toThrow(/more than 0/);

  // Rows are append-only.
  const paymentId = contract!.payments[0]._id;
  await expect(s.t.run((ctx) => appendOnlyGuardedDb(ctx).patch("contractPayments", paymentId, { amount: 1 }))).rejects.toThrow();
  await expect(s.t.run((ctx) => appendOnlyGuardedDb(ctx).delete("contractPayments", paymentId))).rejects.toThrow();
});

test("a wrong payment is reversed only through the Chief Admin's approval", async () => {
  const s = await setup();
  const { contractId } = await createContract(s, { days: 1, dayRate: 10_000, firstPayment: { amount: 4_000, method: "mobile_money" } });
  const paymentId = (await getContract(s, contractId))!.payments[0]._id;
  const approvalId = await s.as(s.chief).mutation(api.contractPayments.requestReversal, { paymentId, reason: "Typed twice" });
  await expect(s.as(s.chief).mutation(api.contractPayments.requestReversal, { paymentId, reason: "Again" })).rejects.toThrow(/already waiting/);
  expect((await getContract(s, contractId))!.payments[0].reversalPending).toBe(true);
  // Nobody approves their own request.
  await expect(s.as(s.chief).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" })).rejects.toThrow();
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  const contract = await getContract(s, contractId);
  expect(contract).toMatchObject({ amountPaid: 0, balance: 10_000, paymentStatus: "open" });
  expect(contract!.payments.find((p) => p._id === paymentId)?.reversed).toBe(true);
  expect(await clientBalance(s)).toBe(10_000);
});

test("edits with a reason: totals, revenue and the client's balance follow; never below what's paid", async () => {
  const s = await setup();
  const { contractId } = await createContract(s, { startDay: "2026-10-01", days: 2, dayRate: 10_000, firstPayment: { amount: 15_000, method: "cash" } });
  const edit = (fields: Partial<{ days: number; dayRate: number; reason: string }>) =>
    s.as(s.chief).mutation(api.contracts.update, {
      contractId,
      startDay: "2026-10-01",
      days: fields.days ?? 2,
      dayRate: fields.dayRate ?? 10_000,
      driverDayRate: 2_000,
      driverId: s.jean,
      reason: fields.reason ?? "Client extended",
    });
  await expect(edit({ days: 3, reason: " " })).rejects.toThrow(/Say why/);
  await expect(edit({ days: 1 })).rejects.toThrow(/less than what the client already paid/);
  await edit({ days: 3 });
  expect(await getContract(s, contractId)).toMatchObject({ endDay: "2026-10-03", totalAmount: 30_000, balance: 15_000, driverPayTotal: 6_000 });
  expect(await clientBalance(s)).toBe(15_000);
  expect(await salesByDay(s)).toEqual({ "2026-10-01": 10_000, "2026-10-02": 10_000, "2026-10-03": 10_000 });
  await expectRollupsMatchRebuild(s);
  const audit = (await s.t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.entityTable === "contracts" && a.action === "update" && a.reason);
  expect(audit.at(-1)).toMatchObject({ reason: "Client extended", before: { days: 2, totalAmount: 20_000 }, after: { days: 3, totalAmount: 30_000 } });
});

test("delete through approval, only without payments; revenue and balance go back", async () => {
  const s = await setup();
  const paid = await createContract(s, { startDay: "2026-10-01", days: 1, firstPayment: { amount: 1_000, method: "cash" } });
  await expect(s.as(s.chief).mutation(api.contracts.requestDelete, { contractId: paid.contractId, reason: "Mistake" })).rejects.toThrow(
    /has payments/,
  );
  const { contractId } = await createContract(s, { startDay: "2026-11-01", days: 2, dayRate: 10_000 });
  const approvalId = await s.as(s.chief).mutation(api.contracts.requestDelete, { contractId, reason: "Entered twice" });
  expect((await getContract(s, contractId))!.deletePending).toBe(true);
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  expect(await getContract(s, contractId)).toBeNull();
  expect(await clientBalance(s)).toBe(15_000 - 1_000);
  expect(Object.keys(await salesByDay(s))).toEqual(["2026-10-01"]);
  await expectRollupsMatchRebuild(s);
});

test("the list: newest start first, filtered by car, client, dates and payment status", async () => {
  const s = await setup();
  const a = await createContract(s, { startDay: "2026-10-01", days: 2, firstPayment: { amount: 30_000, method: "cash" } });
  const b = await createContract(s, { startDay: "2026-10-10", days: 2 });
  const c = await createContract(s, { carId: s.car2, startDay: "2026-10-05", days: 2 });
  const list = (filters: Partial<{ carId: Id<"cars">; from: string; to: string; paymentStatus: "open" | "settled"; clientId: Id<"clients"> }> = {}) =>
    s.as(s.chief)
      .query(api.contracts.list, { businessUnitKey: "transport", paginationOpts: PAGE, ...filters })
      .then((r) => r.page.map((x) => x.number));
  expect(await list()).toEqual([b.number, c.number, a.number]);
  expect(await list({ carId: s.car })).toEqual([b.number, a.number]);
  expect(await list({ from: "2026-10-04", to: "2026-10-09" })).toEqual([c.number]);
  expect(await list({ paymentStatus: "settled" })).toEqual([a.number]);
  expect(await list({ clientId: s.mining, paymentStatus: "open" })).toEqual([b.number, c.number]);
});

test("driver payments: in parts, each waits for the Chief Admin; never above the driver's total", async () => {
  const s = await setup();
  // 3 days at $25 a day for the driver = $75.
  const { contractId } = await createContract(s, { startDay: "2026-10-01", days: 3, dayRate: 10_000, driverDayRate: 2_500 });
  const pay = (amount: number, who = s.chief, paidOn?: string) =>
    s.as(who).mutation(api.driverPayments.request, { contractId, amount, method: "mobile_money", ...(paidOn ? { paidOn } : {}) });
  const decide = async (paymentId: Id<"driverPayments">, decision: "approve" | "reject", who = s.superAdmin) => {
    const approvalId = (await s.t.run((ctx) => ctx.db.get("driverPayments", paymentId)))!.approvalId!;
    return s.as(who).mutation(api.approvals.decideApproval, { approvalId, decision });
  };

  await expect(pay(1_000, s.manager)).rejects.toThrow(/transport\.driver_pay\.request/);
  const first = await pay(5_000, s.chief, "2026-10-02");
  // Pending counts against the total.
  await expect(pay(3_000)).rejects.toThrow(/more than the driver is still owed/);
  expect(await getContract(s, contractId)).toMatchObject({ driverPaid: 0, driverPending: 5_000, driverOwed: 2_500 });
  // Nobody approves their own request; nothing changes until approved.
  await expect(decide(first, "approve", s.chief)).rejects.toThrow();
  expect((await s.t.run((ctx) => ctx.db.query("dailyFinance").collect())).every((r) => r.payroll === 0)).toBe(true);

  await decide(first, "approve");
  expect(await getContract(s, contractId)).toMatchObject({ driverPaid: 5_000, driverPending: 0, driverOwed: 2_500 });
  // Approved driver pay counts as payroll on its day, business-level.
  const row = await s.t.run(async (ctx) =>
    (await ctx.db.query("dailyFinance").collect()).find((r) => r.locationKey === "*" && r.day === "2026-10-02"),
  );
  expect(row).toMatchObject({ payroll: 5_000, sales: 10_000 });

  // A rejection changes nothing but its status, and frees the amount again.
  const second = await pay(2_500);
  await decide(second, "reject");
  expect(await getContract(s, contractId)).toMatchObject({ driverPaid: 5_000, driverOwed: 2_500 });
  const third = await pay(2_500);
  await decide(third, "approve");
  const contract = await getContract(s, contractId);
  expect(contract).toMatchObject({ driverPaid: 7_500, driverOwed: 0 });
  expect(contract!.driverPayments.map((p) => p.status).sort()).toEqual(["approved", "approved", "rejected"]);
  await expectRollupsMatchRebuild(s);

  // The driver's total can't drop below what's paid; a contract with driver payments can't be deleted.
  await expect(
    s.as(s.chief).mutation(api.contracts.update, {
      contractId,
      startDay: "2026-10-01",
      days: 2,
      dayRate: 10_000,
      driverDayRate: 2_500,
      driverId: s.jean,
      reason: "Shorter",
    }),
  ).rejects.toThrow(/less than what they were already paid/);
  await expect(s.as(s.chief).mutation(api.contracts.requestDelete, { contractId, reason: "x" })).rejects.toThrow(/has payments/);
});

test("the Super Admin may approve their own driver payment (flagged)", async () => {
  const s = await setup();
  const { contractId } = await createContract(s, { days: 1, driverDayRate: 2_000 });
  const paymentId = await s.as(s.superAdmin).mutation(api.driverPayments.request, { contractId, amount: 2_000, method: "cash" });
  const approvalId = (await s.t.run((ctx) => ctx.db.get("driverPayments", paymentId)))!.approvalId!;
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });
  expect((await s.t.run((ctx) => ctx.db.get("driverPayments", paymentId)))!.status).toBe("approved");
  const audit = (await s.t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.entityTable === "approvals" && a.action === "approve");
  expect(JSON.stringify(audit.at(-1))).toContain("selfApproved");
});
