import { afterEach, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { ALL } from "./lib/analytics";
import { reportBuilder } from "./lib/reports";
import { addBusinessDays, businessDayOf } from "./lib/time";
import { arrivedMixedBatch, receiveAll, setupStock, PAGE, type Setup } from "./lib/stock.test.utils";

const modules = import.meta.glob("./**/*.*s");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Goma Shop (open every day) holds P1 x6 and P2 x3. P1 is low (threshold
 * 20), P2 sold out by a cash sale today; Mama Neema owes $10.00 on credit
 * (today), Baba Joe $5.00 (P1 x1 sold on day -4, the oldest debt).
 * Rollups: $1.00 at the shop on day -10 (first sale), $2.00 on day -5;
 * day -3 is marked "Closed / no sales".
 */
async function setup() {
  const s = await setupStock(modules);
  const b = await arrivedMixedBatch(s);
  await receiveAll(s, b.batchId);
  const lots = await s.t.run((ctx) =>
    ctx.db.query("inventoryBatches").withIndex("by_stockBatchId", (q) => q.eq("stockBatchId", b.batchId)).collect(),
  );
  const p1Lot = lots.find((l) => l.sourceStockBatchItemId === b.i1._id)!._id;
  const p2Lot = lots.find((l) => l.sourceStockBatchItemId === b.i2._id)!._id;
  const today = businessDayOf(Date.now());
  const day = (n: number) => addBusinessDays(today, n);

  await s.t.run(async (ctx) => {
    await ctx.db.patch("locations", s.shop, { openDays: [0, 1, 2, 3, 4, 5, 6] });
    await ctx.db.patch("products", s.p1, { lowStockThreshold: 20 });
    const business = await getOrCreateHolder(ctx, s.hairId, businessHolderRef(s.hairId));
    const shopHolder = await getOrCreateHolder(ctx, s.hairId, { type: "location", refId: s.shop });
    for (const [lot, qty] of [[p1Lot, 6], [p2Lot, 3]] as const) {
      await applyMovement(ctx, { type: "distribute", inventoryBatchId: lot, fromHolderId: business, toHolderId: shopHolder, qty, refTable: "test", refId: "setup", actorId: s.chief });
    }
    // Past sales straight into the rollups (the sale flow can't backdate 10 days).
    for (const [d, sales] of [[day(-10), 100], [day(-5), 200], [day(-12), 50]] as const) {
      for (const locationKey of [s.shop, ALL]) {
        await ctx.db.insert("dailyFinance", { businessUnitId: s.hairId, locationKey, day: d, sales, saleCost: 0, expenses: 0, payroll: 0, withdrawals: 0 });
      }
    }
  });
  await s.t.mutation(internal.inventory.rebuildProductStock, { businessUnitKey: "hair" });
  await s.as(s.superAdmin).mutation(api.salesDays.markClosed, { businessUnitKey: "hair", locationId: s.shop, day: day(-3) });

  // P2 sold out (cash), P1 x2 on credit to Mama Neema.
  await s.as(s.agent).mutation(api.sales.create, { businessUnitKey: "hair", paymentMethod: "cash", lines: [{ inventoryBatchId: p2Lot, qty: 3, unitPrice: 1500 }] });
  const neema = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Mama Neema" });
  await s.as(s.agent).mutation(api.sales.create, { businessUnitKey: "hair", paymentMethod: "credit", customerId: neema, lines: [{ inventoryBatchId: p1Lot, qty: 2, unitPrice: 500 }] });
  const joe = await s.as(s.agent).mutation(api.customers.create, { businessUnitKey: "hair", name: "Baba Joe" });
  await s.as(s.agent).mutation(api.sales.create, {
    businessUnitKey: "hair",
    paymentMethod: "credit",
    customerId: joe,
    soldOn: day(-4),
    lines: [{ inventoryBatchId: p1Lot, qty: 1, unitPrice: 500 }],
  });
  return { ...s, today, day, neema, joe, p1Lot };
}

const generate = (s: Setup, who: Id<"users">, from: string, to: string) =>
  s.as(who).mutation(api.reports.generate, { businessUnitKey: "hair", from, to });
const getReport = (s: Setup, who: Id<"users">, reportId: Id<"reports">) => s.as(who).query(api.reports.get, { reportId });
const audits = (s: Setup, entityTable: string) =>
  s.t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_entityTable_and_timestamp", (q) => q.eq("entityTable", entityTable)).collect());

test("owners and admins only; the cash section only for the owner", async () => {
  const s = await setup();
  for (const who of [s.agent, s.sales, s.manager, s.inventory]) {
    await expect(generate(s, who, s.day(-9), s.day(-1))).rejects.toThrow(/reports\.generate/);
    await expect(s.as(who).query(api.reports.list, { businessUnitKey: "hair", paginationOpts: PAGE })).rejects.toThrow(/reports\.view/);
    await expect(s.as(who).query(api.reports.getSettings, { businessUnitKey: "hair" })).rejects.toThrow(/reports\.settings/);
  }
  const id = await generate(s, s.superAdmin, s.day(-9), s.day(-1));
  expect((await getReport(s, s.superAdmin, id))!.content.cash).toBeDefined();
  const chiefView = (await getReport(s, s.chief, id))!;
  expect(chiefView.content.cash).toBeUndefined();
  expect(chiefView.sections).not.toContain("cash");
  // The Chief Admin's own reports never hold cash.
  const chiefId = await generate(s, s.chief, s.day(-9), s.day(-1));
  expect(await s.t.run(async (ctx) => (await ctx.db.get("reports", chiefId))!.sections)).not.toContain("cash");
});

test("a custom report: sales vs the previous equal period, missing days, stock, approvals, money owed, cash", async () => {
  const s = await setup();
  const id = await generate(s, s.superAdmin, s.day(-9), s.day(-1));
  const report = (await getReport(s, s.superAdmin, id))!;
  expect(report).toMatchObject({ kind: "custom", from: s.day(-9), to: s.day(-1), status: "ready", createdByName: "Super" });
  const { content } = report;

  // $2.00 (rollups, day -5) + $5.00 (Baba Joe, day -4); before: $1.50.
  expect(content.sales).toMatchObject({
    total: 700,
    previousTotal: 150,
    compareFrom: s.day(-18),
    compareTo: s.day(-10),
    figures: { sales: 700, margin: 500, expenses: 0, payroll: 0, netProfit: 500, withdrawals: 0 },
    previous: { sales: 150, netProfit: 150 },
    byShop: [{ locationId: s.shop, name: "Goma Shop", sales: 700 }],
    topProducts: [{ productId: s.p1, name: "P1", unitsSold: 1, revenue: 500, margin: 300 }],
    missingDaysCount: 6,
  });
  // Open days with no sale, minus day -5 and -4 (sold) and day -3 (marked closed).
  const expected = [-9, -8, -7, -6, -2, -1].map(s.day);
  expect(content.missingDays).toEqual({
    count: 6,
    shops: [{ locationId: s.shop, name: "Goma Shop", days: expected, count: 6, truncated: false }],
  });

  // P1: 3 sold in 30 days, low level 20, 7 left -> reorder 13. P2: 3 sold, none left -> 3.
  expect(content.stock).toMatchObject({
    lowCount: 1,
    outCount: 1,
    low: [{ name: "P1", onHand: 7, sold30: 3, reorderQty: 13 }],
    out: [{ name: "P2", onHand: 0, sold30: 3, reorderQty: 3 }],
  });
  expect(content.stock!.out[0].outOfStockSince).toEqual(expect.any(Number));
  // Stock value = the Stock page's figure (purchase cost).
  const overview = await s.as(s.superAdmin).query(api.inventory.overview, { businessUnitKey: "hair" });
  expect(content.stock!.value).toBe(overview.byHolder.reduce((t, h) => t + h.value, 0));
  expect(content.stock!.unitsOnHand).toBe(overview.byHolder.reduce((t, h) => t + h.qty, 0));

  // Oldest debt first, with its date and days unpaid.
  expect(content.credit).toMatchObject({
    totalOwed: 1500,
    customers: 2,
    top: [
      { customerId: s.joe, name: "Baba Joe", balance: 500, daysUnpaid: 4 },
      { customerId: s.neema, name: "Mama Neema", balance: 1000, daysUnpaid: 0 },
    ],
  });
  expect(content.approvals).toEqual({ count: 0, byType: [], items: [] });
  // Cash on hand: today's $45.00 cash sale.
  expect(content.cash).toEqual({ onHand: 4500, pendingOpeningCash: 0, pendingOpeningCashCount: 0, currency: "USD" });

  // A pending opening cash and its approval show up in the next report, with amount and requester.
  await s.as(s.superAdmin).mutation(api.cash.createOpeningCash, { businessUnitKey: "hair", amount: 700, note: "Safe", receivedByName: "Mama" });
  const next = (await getReport(s, s.superAdmin, await generate(s, s.superAdmin, s.day(-9), s.day(-1))))!.content;
  expect(next.cash).toMatchObject({ onHand: 4500, pendingOpeningCash: 700, pendingOpeningCashCount: 1 });
  expect(next.approvals).toMatchObject({
    count: 1,
    byType: [{ type: "opening_cash", count: 1 }],
    items: [{ type: "opening_cash", amount: 700, currency: "USD", requestedByName: "Super", requestedAt: expect.any(Number) }],
  });

  // Saved as history, newest first.
  const list = await s.as(s.chief).query(api.reports.list, { businessUnitKey: "hair", paginationOpts: PAGE });
  expect(list.page.map((r) => r.kind)).toEqual(["custom", "custom"]);
});

test("no comparison when the period before has no data", async () => {
  const s = await setup();
  // Days -40..-31: nothing recorded in them or in the 10 days before.
  const sales = (await getReport(s, s.superAdmin, await generate(s, s.superAdmin, s.day(-40), s.day(-31))))!.content.sales!;
  expect(sales).toMatchObject({ total: 0, previousTotal: null, compareFrom: null, compareTo: null, previous: null });
});

test("long periods: counts per shop, only the latest 14 dates listed", async () => {
  const s = await setup();
  // 60 days; the shop's first sale was day -12, so days -12..-1 can be missing.
  await s.t.run((ctx) =>
    ctx.db.insert("dailyFinance", { businessUnitId: s.hairId, locationKey: s.shop, day: s.day(-59), sales: 10, saleCost: 0, expenses: 0, payroll: 0, withdrawals: 0 }),
  );
  const content = (await getReport(s, s.superAdmin, await generate(s, s.superAdmin, s.day(-60), s.day(-1))))!.content;
  const [shop] = content.missingDays!.shops;
  expect(shop.count).toBeGreaterThan(14);
  expect(shop.truncated).toBe(true);
  expect(shop.days).toHaveLength(14);
  expect(shop.days.at(-1)).toBe(s.day(-1));
  expect(content.missingDays!.count).toBe(shop.count);
});

test("a report saved before the new fields still opens", async () => {
  const s = await setup();
  const id = await s.t.run((ctx) =>
    ctx.db.insert("reports", {
      businessUnitId: s.hairId,
      kind: "custom",
      createdBy: s.superAdmin,
      from: s.day(-7),
      to: s.day(-1),
      sections: ["sales", "credit"],
      status: "ready",
      attempts: 1,
      generatedAt: Date.now(),
      content: {
        sales: { total: 100, previousTotal: null, compareFrom: null, compareTo: null, currency: "USD" },
        credit: { totalOwed: 0, customers: 0, top: [], currency: "USD" },
      },
    }),
  );
  expect((await getReport(s, s.superAdmin, id))!.content.sales).toEqual({ total: 100, previousTotal: null, compareFrom: null, compareTo: null, currency: "USD" });
});

test("custom range: at most 12 months, never in the future; each report audited", async () => {
  const s = await setup();
  await expect(generate(s, s.superAdmin, addBusinessDays(s.today, -366), s.today)).rejects.toThrow(/366/);
  await expect(generate(s, s.superAdmin, s.today, s.day(1))).rejects.toThrow(/future/);
  const id = await generate(s, s.superAdmin, addBusinessDays(s.today, -365), s.today);
  expect(await audits(s, "reports")).toMatchObject([{ action: "create", entityId: id, actorId: s.superAdmin, after: { kind: "custom", status: "ready" } }]);
});

test("a report never changes stock, money or sales", async () => {
  const s = await setup();
  const state = () =>
    s.t.run(async (ctx) =>
      JSON.stringify([
        await ctx.db.query("stockLevels").collect(),
        await ctx.db.query("productStock").collect(),
        await ctx.db.query("dailyFinance").collect(),
        await ctx.db.query("dailyStats").collect(),
        await ctx.db.query("sales").collect(),
        await ctx.db.query("customers").collect(),
        await ctx.db.query("approvals").collect(),
      ]),
    );
  const before = await state();
  await generate(s, s.superAdmin, s.day(-30), s.today);
  expect(await state()).toBe(before);
});

type SettingsArgs = FunctionArgs<typeof api.reports.saveSettings>;
const saveSettings = (s: Setup, who: Id<"users">, fields: Partial<SettingsArgs> = {}) =>
  s.as(who).mutation(api.reports.saveSettings, {
    businessUnitKey: "hair",
    enabled: true,
    frequency: "weekly",
    dayOfWeek: 0,
    dayOfMonth: 1,
    time: "09:00",
    sections: ["sales", "missingDays", "stock", "approvals", "credit", "cash"],
    recipientIds: [s.superAdmin, s.chief],
    channels: ["in_app"],
    ...fields,
  });

test("settings: default Sunday 09:00, validated, per owner, audited", async () => {
  const s = await setup();
  expect(await s.as(s.superAdmin).query(api.reports.getSettings, { businessUnitKey: "hair" })).toMatchObject({
    saved: false,
    enabled: false,
    frequency: "weekly",
    dayOfWeek: 0,
    time: "09:00",
    recipientIds: [s.superAdmin],
    channels: ["in_app"],
  });
  await expect(saveSettings(s, s.superAdmin, { time: "09:10" })).rejects.toThrow(/quarter hour/);
  await expect(saveSettings(s, s.superAdmin, { channels: ["email"] })).rejects.toThrow(/Email/);
  await expect(saveSettings(s, s.superAdmin, { recipientIds: [s.agent] })).rejects.toThrow(/can see reports/);
  await expect(saveSettings(s, s.chief)).rejects.toThrow(/cash section/);

  await saveSettings(s, s.superAdmin);
  const mine = await s.as(s.superAdmin).query(api.reports.getSettings, { businessUnitKey: "hair" });
  expect(mine).toMatchObject({ saved: true, enabled: true, recipientIds: [s.superAdmin, s.chief] });
  expect(new Date(mine.nextRunAt!).getUTCDay()).toBe(0);
  expect(new Date(mine.nextRunAt!).getUTCHours()).toBe(7); // 09:00 Lubumbashi
  // The Chief Admin's set-up is their own.
  expect((await s.as(s.chief).query(api.reports.getSettings, { businessUnitKey: "hair" })).saved).toBe(false);

  await saveSettings(s, s.superAdmin, { frequency: "daily" });
  await saveSettings(s, s.superAdmin, { frequency: "daily" }); // no change: no entry
  expect((await audits(s, "reportSettings")).map((a) => a.action)).toEqual(["create", "update"]);
});

async function runDueAt(s: Setup, ms: number) {
  vi.setSystemTime(ms);
  await s.t.mutation(internal.reports.runDue, {});
  await s.t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

const reports = (s: Setup) => s.t.run((ctx) => ctx.db.query("reports").collect());
const settingsRow = (s: Setup) => s.t.run(async (ctx) => (await ctx.db.query("reportSettings").collect())[0]);

test("scheduled: runs once when due, covers Monday-Sunday, notifies recipients, audited", async () => {
  const s = await setup();
  vi.useFakeTimers({ now: Date.now() });
  await saveSettings(s, s.superAdmin);
  const { nextRunAt } = await settingsRow(s);

  await runDueAt(s, nextRunAt - 60_000); // not yet
  expect(await reports(s)).toHaveLength(0);

  await runDueAt(s, nextRunAt + 60_000);
  await runDueAt(s, nextRunAt + 120_000); // already moved on: no second run
  const [report] = await reports(s);
  expect(await reports(s)).toHaveLength(1);
  const sunday = businessDayOf(nextRunAt);
  expect(report).toMatchObject({ kind: "scheduled", status: "ready", attempts: 1, from: addBusinessDays(sunday, -6), to: sunday, createdBy: s.superAdmin });
  expect((await settingsRow(s)).nextRunAt).toBe(nextRunAt + 7 * 86_400_000);

  for (const who of [s.superAdmin, s.chief]) {
    const inbox = await s.as(who).query(api.reports.myNotifications, {});
    expect(inbox).toMatchObject({ unread: 1, items: [{ reportId: report._id, businessUnitKey: "hair", read: false }] });
  }
  // Each person marks only their own.
  await s.as(s.chief).mutation(api.reports.markRead, {});
  expect((await s.as(s.chief).query(api.reports.myNotifications, {})).unread).toBe(0);
  expect((await s.as(s.superAdmin).query(api.reports.myNotifications, {})).unread).toBe(1);
  expect(await audits(s, "reports")).toMatchObject([{ action: "create", actorId: s.superAdmin, after: { kind: "scheduled" } }]);
});

test("scheduled: a failed run is retried once", async () => {
  const s = await setup();
  vi.useFakeTimers({ now: Date.now() });
  await saveSettings(s, s.superAdmin);
  const { nextRunAt } = await settingsRow(s);
  vi.spyOn(reportBuilder, "build").mockRejectedValueOnce(new Error("boom"));
  await runDueAt(s, nextRunAt + 60_000);
  expect(await reports(s)).toMatchObject([{ status: "ready", attempts: 2 }]);
});

test("scheduled: failing twice saves a failed report and tells the owner", async () => {
  const s = await setup();
  vi.useFakeTimers({ now: Date.now() });
  await saveSettings(s, s.superAdmin);
  const { nextRunAt } = await settingsRow(s);
  vi.spyOn(reportBuilder, "build").mockRejectedValue(new Error("boom"));
  await runDueAt(s, nextRunAt + 60_000);
  const [report] = await reports(s);
  expect(report).toMatchObject({ status: "failed", attempts: 2, error: expect.stringContaining("boom") });
  expect((await s.as(s.superAdmin).query(api.reports.myNotifications, {})).unread).toBe(1);
  expect((await s.as(s.chief).query(api.reports.myNotifications, {})).unread).toBe(0);
  expect(await audits(s, "reports")).toMatchObject([{ after: { status: "failed" } }]);
});

test("switched off, or the owner lost access: nothing runs", async () => {
  const s = await setup();
  vi.useFakeTimers({ now: Date.now() });
  await saveSettings(s, s.superAdmin, { enabled: false });
  const { nextRunAt } = await settingsRow(s);
  await runDueAt(s, nextRunAt + 60_000);
  expect(await reports(s)).toHaveLength(0);
});
