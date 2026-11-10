import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, type Setup } from "./lib/stock.test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };
const today = () => businessDayOf(Date.now());

/** A seeded Hair unit; Goma Shop holds 6 of P1 for the cash-on-hand test. */
async function setup() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const p1Lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!._id;
  await s.t.run(async (ctx) =>
    applyMovement(ctx, {
      type: "distribute",
      inventoryBatchId: p1Lot,
      fromHolderId: await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId)),
      toHolderId: await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop }),
      qty: 6,
      refTable: "test",
      refId: "setup",
      actorId: s.chief,
    }),
  );
  return { ...s, p1Lot };
}

const record = (
  s: Setup,
  who: Id<"users">,
  fields: Partial<{ amount: number; date: string; note: string; receivedByName: string; receivedByUserId: Id<"users">; locationId: Id<"locations"> }> = {},
) =>
  s.as(who).mutation(api.cash.createOpeningCash, {
    businessUnitKey: "hair",
    amount: fields.amount ?? 5_000,
    note: fields.note ?? "Cash in the safe before we started",
    ...(fields.receivedByUserId ? { receivedByUserId: fields.receivedByUserId } : { receivedByName: fields.receivedByName ?? "Mama Neema" }),
    ...(fields.date ? { date: fields.date } : {}),
    ...(fields.locationId ? { locationId: fields.locationId } : {}),
  }).then((r) => r.id);
const reverse = (s: Setup, who: Id<"users">, openingCashId: Id<"openingCash">, reason = "Counted twice") =>
  s.as(who).mutation(api.cash.reverseOpeningCash, { openingCashId, reason });
const row = (s: Setup, id: Id<"openingCash">) => s.t.run((ctx) => ctx.db.get("openingCash", id));
const decide = async (s: Setup, who: Id<"users">, id: Id<"openingCash">, decision: "approve" | "reject") =>
  s.as(who).mutation(api.approvals.decideApproval, { approvalId: (await row(s, id))!.approvalId!, decision });
const onHand = (s: Setup, locationId?: Id<"locations">) =>
  s.as(s.superAdmin).query(api.cash.onHand, { businessUnitKey: "hair", ...(locationId ? { locationId } : {}) });
const setThreshold = (s: Setup, threshold: number, who = s.superAdmin) =>
  s.as(who).mutation(api.cash.setOpeningCashThreshold, { businessUnitKey: "hair", threshold });

test("owner only: no other role can view, record, approve or change the threshold", async () => {
  const s = await setup();
  for (const who of [s.chief, s.sales, s.manager, s.inventory, s.agent]) {
    await expect(record(s, who)).rejects.toThrow(/cash\.opening\.record/);
    await expect(s.as(who).query(api.cash.onHand, { businessUnitKey: "hair" })).rejects.toThrow(/cash\.view/);
    await expect(s.as(who).query(api.cash.openingCashTotals, { businessUnitKey: "hair" })).rejects.toThrow(/cash\.view/);
    await expect(setThreshold(s, 100, who)).rejects.toThrow(/cash\.settings/);
  }
  const id = await record(s, s.superAdmin);
  // The Chief Admin sees every approval but can't decide this one.
  await expect(decide(s, s.chief, id, "approve")).rejects.toThrow(/cash\.opening\.approve/);
});

test("no threshold set: every amount waits in Approvals; the owner approves (flagged) or rejects", async () => {
  const s = await setup();
  const id = await record(s, s.superAdmin, { amount: 5_000 });
  expect(await row(s, id)).toMatchObject({ kind: "record", status: "pending", currency: "USD", receivedByName: "Mama Neema" });
  expect(await onHand(s)).toMatchObject({ openingCash: 0, total: 0 });

  await decide(s, s.superAdmin, id, "approve");
  expect((await row(s, id))!.status).toBe("approved");
  expect(await onHand(s)).toMatchObject({ openingCash: 5_000, total: 5_000 });
  const approvalId = (await row(s, id))!.approvalId!;
  const audits = await s.t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(audits.find((a) => a.entityId === approvalId && a.action === "approve")!.after).toMatchObject({ selfApproved: true });
  expect(audits.filter((a) => a.entityTable === "openingCash").map((a) => [a.action, (a.after as { status: string }).status])).toEqual([
    ["create", "pending"],
    ["update", "approved"],
  ]);

  const rejected = await record(s, s.superAdmin, { amount: 2_000 });
  await decide(s, s.superAdmin, rejected, "reject");
  expect((await row(s, rejected))!.status).toBe("rejected");
  expect(await s.as(s.superAdmin).query(api.cash.openingCashTotals, { businessUnitKey: "hair" })).toMatchObject({
    approved: 5_000,
    pending: 0,
  });
});

test("the threshold: at or below it applies at once, above it waits; changes are audited", async () => {
  const s = await setup();
  await expect(setThreshold(s, -1)).rejects.toThrow(/threshold/);
  await setThreshold(s, 10_000);
  await setThreshold(s, 10_000); // no-op
  await setThreshold(s, 20_000);
  expect(await s.as(s.superAdmin).query(api.cash.getSettings, { businessUnitKey: "hair" })).toMatchObject({
    openingCashApprovalThreshold: 20_000,
  });
  const settingsAudits = await s.t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "cashSettings").map((a) => [a.action, a.after]),
  );
  expect(settingsAudits).toEqual([
    ["create", { approvalThresholdAmount: 10_000, currency: "USD" }],
    ["update", { approvalThresholdAmount: 20_000, currency: "USD" }],
  ]);

  const small = await record(s, s.superAdmin, { amount: 20_000 });
  expect(await row(s, small)).toMatchObject({ status: "approved" });
  expect((await row(s, small))!.approvalId).toBeUndefined();
  const big = await record(s, s.superAdmin, { amount: 20_001 });
  expect(await row(s, big)).toMatchObject({ status: "pending" });
  expect(await onHand(s)).toMatchObject({ openingCash: 20_000 });
  expect(await s.as(s.superAdmin).query(api.cash.openingCashTotals, { businessUnitKey: "hair" })).toMatchObject({
    approved: 20_000,
    pending: 20_001,
  });
});

test("no edit or delete: a mistake is reversed once, with a reason, under the same threshold rule", async () => {
  const s = await setup();
  await setThreshold(s, 10_000);
  const small = await record(s, s.superAdmin, { amount: 4_000 });
  const big = await record(s, s.superAdmin, { amount: 15_000 });

  await expect(reverse(s, s.superAdmin, big)).rejects.toThrow(/Only approved/);
  await expect(reverse(s, s.superAdmin, small, " ")).rejects.toThrow(/reason/);
  await expect(reverse(s, s.chief, small)).rejects.toThrow(/cash\.opening\.record/);

  const smallReversal = await reverse(s, s.superAdmin, small);
  expect(smallReversal.status).toBe("approved");
  expect(await row(s, smallReversal.id)).toMatchObject({ kind: "reversal", reversesId: small, amount: 4_000, reason: "Counted twice" });
  expect(await onHand(s)).toMatchObject({ openingCash: 0 });
  await expect(reverse(s, s.superAdmin, small)).rejects.toThrow(/already reversed/);
  await expect(reverse(s, s.superAdmin, smallReversal.id)).rejects.toThrow(/can't be reversed/);

  await decide(s, s.superAdmin, big, "approve");
  expect(await onHand(s)).toMatchObject({ openingCash: 15_000 });
  const bigReversal = await reverse(s, s.superAdmin, big, "Belongs to Mode");
  expect(bigReversal.status).toBe("pending");
  await expect(reverse(s, s.superAdmin, big)).rejects.toThrow(/already reversed/);
  expect(await onHand(s)).toMatchObject({ openingCash: 15_000 });
  await decide(s, s.superAdmin, bigReversal.id, "approve");
  expect(await onHand(s)).toMatchObject({ openingCash: 0 });
  expect(await s.as(s.superAdmin).query(api.cash.openingCashTotals, { businessUnitKey: "hair" })).toMatchObject({
    approved: 0,
    pending: 0,
  });

  // The list shows each record's reversal.
  const list = await s.as(s.superAdmin).query(api.cash.listOpeningCash, { businessUnitKey: "hair", paginationOpts: PAGE });
  expect(list.page.find((r) => r._id === big)!.reversal).toMatchObject({ status: "approved", reason: "Belongs to Mode" });

  // Every step is in the audit log; the records themselves were never changed.
  expect((await row(s, small))!.status).toBe("approved");
  const audits = await s.t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityTable === "openingCash"));
  expect(audits.filter((a) => a.action === "create")).toHaveLength(4);
  expect(audits.find((a) => a.entityId === smallReversal.id)!.reason).toBe("Counted twice");
});

test("validation, date filters and the export", async () => {
  const s = await setup();
  await setThreshold(s, 1_000_000);
  await expect(record(s, s.superAdmin, { note: "  " })).rejects.toThrow(/note/);
  await expect(record(s, s.superAdmin, { receivedByName: " " })).rejects.toThrow(/who received/);
  await expect(record(s, s.superAdmin, { amount: 0 })).rejects.toThrow(/cents above 0/);
  await expect(record(s, s.superAdmin, { amount: 1.5 })).rejects.toThrow(/cents above 0/);
  await expect(record(s, s.superAdmin, { date: addBusinessDays(today(), 1) })).rejects.toThrow(/future/);
  await expect(record(s, s.superAdmin, { date: "2026-02-30" })).rejects.toThrow(/YYYY-MM-DD/);

  const lastWeek = addBusinessDays(today(), -7);
  await record(s, s.superAdmin, { amount: 1_000, date: lastWeek });
  await record(s, s.superAdmin, { amount: 2_000, receivedByUserId: s.sales, locationId: s.shop });
  const filtered = (from: string, to: string) =>
    s.as(s.superAdmin).query(api.cash.openingCashTotals, { businessUnitKey: "hair", from, to });
  expect(await filtered(lastWeek, lastWeek)).toMatchObject({ approved: 1_000, count: 1 });
  expect(await filtered(today(), today())).toMatchObject({ approved: 2_000, count: 1 });
  const exported = await s.as(s.superAdmin).query(api.cash.exportOpeningCash, { businessUnitKey: "hair" });
  expect(exported.map((r) => [r.amount, r.receivedByName, r.locationName])).toEqual([
    [1_000, "Mama Neema", null],
    [2_000, "Sales", "Goma Shop"],
  ]);
  // Per location: cash on hand at the shop counts only its own opening cash.
  expect(await onHand(s, s.shop)).toMatchObject({ openingCash: 2_000 });
});

test("cash on hand: cash sales and cash payments in, refunds and withdrawals out; never in sales or profit", async () => {
  const s = await setup();
  const sell = (fields: {
    paymentMethod: "cash" | "mobile_money" | "credit";
    customerId?: Id<"customers">;
    paidNow?: number;
    paidNowMethod?: "cash" | "mobile_money";
  }) =>
    s.as(s.agent).mutation(api.sales.create, {
      businessUnitKey: "hair",
      lines: [{ inventoryBatchId: s.p1Lot, qty: 1, unitPrice: 1_000 }],
      ...fields,
    });
  await sell({ paymentMethod: "cash" });
  await sell({ paymentMethod: "mobile_money" });
  const customerId = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Mama Neema" });
  await sell({ paymentMethod: "credit", customerId, paidNow: 300, paidNowMethod: "cash" });
  await s.as(s.agent).mutation(api.credit.recordRepayment, { customerId, amount: 200, method: "mobile_money" });
  await s.as(s.agent).mutation(api.credit.recordRepayment, { customerId, amount: 100, method: "cash" });

  const withdrawal = await s.as(s.chief).mutation(api.withdrawals.create, { businessUnitKey: "hair", amount: 400, reason: "Owner draw", locationId: s.shop });
  const approvalId = (await s.t.run((ctx) => ctx.db.get("withdrawals", withdrawal)))!.approvalId!;
  await s.as(s.superAdmin).mutation(api.approvals.decideApproval, { approvalId, decision: "approve" });

  const summaryBefore = await s.as(s.superAdmin).query(api.analytics.getSummary, { businessUnitKey: "hair", range: { preset: "today" } });
  const opening = await record(s, s.superAdmin, { amount: 5_000, locationId: s.shop });
  await decide(s, s.superAdmin, opening, "approve");

  expect(await onHand(s)).toEqual({
    openingCash: 5_000,
    cashSales: 1_000,
    cashCreditPayments: 400,
    cashRefunds: 0,
    withdrawals: 400,
    total: 6_000,
    currency: "USD",
  });
  expect(await onHand(s, s.shop)).toMatchObject({ total: 6_000 });

  // Opening cash never reaches sales, margin or net profit.
  const summary = await s.as(s.superAdmin).query(api.analytics.getSummary, { businessUnitKey: "hair", range: { preset: "today" } });
  expect(summary).toEqual(summaryBefore);
  expect(summary.sales).toBe(3_000);

  // The rollups equal a rebuild from raw data.
  const finance = () => s.t.run(async (ctx) => (await ctx.db.query("dailyFinance").collect()).map(({ _id, _creationTime, ...r }) => (void _id, void _creationTime, JSON.stringify(r))).sort());
  const before = await finance();
  await s.t.mutation(internal.analytics.rebuildRollups, { businessUnitKey: "hair" });
  expect(await finance()).toEqual(before);
});

test("openingCash rows are never deleted or replaced, and only the opening cash code patches them", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true });
  const removes = /\.(delete|replace)\(\s*["'`]openingCash["'`]/;
  const patches = /\.patch\(\s*["'`]openingCash["'`]/;
  const code = Object.entries(sources).filter(([path]) => !path.includes("_generated") && !path.endsWith(".test.ts"));
  expect(code.filter(([, source]) => removes.test(source as string)).map(([path]) => path)).toEqual([]);
  expect(
    code
      .filter(([path, source]) => patches.test(source as string) && path !== "./cash.ts" && path !== "./lib/openingCash.ts")
      .map(([path]) => path),
  ).toEqual([]);
});
