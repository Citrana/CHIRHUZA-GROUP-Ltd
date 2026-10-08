import { authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { countDecidable } from "./lib/approvals";
import { ALL, monthStart } from "./lib/analytics";
import { saleBalance } from "./lib/credit";
import type { Scope } from "./lib/permissions";
import { addBusinessDays, businessDayOf } from "./lib/time";

/**
 * The Home briefing of a service, in one query: what needs attention and
 * today's figures. Every section is computed only when the caller holds
 * its permission (otherwise null), with location scope like the pages it
 * links to. Money comes from the analytics rollups (dailyFinance), never
 * raw sales. All reads are bounded.
 */

const MAX_ROWS = 2000;
const LAST_SALE_LOOKBACK_DAYS = 90;

export const summary = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const can = (key: Parameters<typeof ctx.can>[0]) => ctx.can(key);
    const today = businessDayOf(Date.now());

    // The rollup key a figure is read at: everywhere, or the user's location.
    const keyFor = (scope: Scope | undefined): string | null =>
      scope === undefined ? null : scope === "all_locations" ? ALL : (ctx.user.locationId ?? null);
    const finance = (locationKey: string, from: string, to: string) =>
      ctx.db
        .query("dailyFinance")
        .withIndex("by_key", (q) =>
          q.eq("businessUnitId", unit._id).eq("locationKey", locationKey).gte("day", from).lte("day", to),
        )
        .take(400);

    const approvalsWaiting = await countDecidable(ctx, unit._id);

    // Stock: low / out counts, and units on hand anywhere.
    let stock: { low: number; out: number; unitsOnHand: number } | null = null;
    if (can("stock.view")) {
      const rows = async (status: "in_stock" | "low" | "out") =>
        await ctx.db
          .query("productStock")
          .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
          .take(MAX_ROWS);
      const [inStock, low, out] = [await rows("in_stock"), await rows("low"), await rows("out")];
      stock = {
        low: low.length,
        out: out.length,
        unitsOnHand: [...inStock, ...low].reduce((t, r) => t + r.onHand, 0),
      };
    }

    const productsActive =
      can("products.view") || can("products.manage")
        ? (
            await ctx.db
              .query("products")
              .withIndex("by_businessUnitId_and_status_and_name", (q) => q.eq("businessUnitId", unit._id).eq("status", "active"))
              .take(MAX_ROWS * 2)
          ).length
        : null;

    let requisitionsOpen: number | null = null;
    if (can("requisition.view") || can("requisition.create")) {
      requisitionsOpen = 0;
      for (const status of ["submitted", "approved", "purchasing"] as const) {
        requisitionsOpen += (
          await ctx.db
            .query("requisitions")
            .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
            .take(MAX_ROWS)
        ).length;
      }
    }

    const batchesToReceive = can("stock.receive")
      ? (
          await ctx.db
            .query("stockBatches")
            .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", "arrived"))
            .take(MAX_ROWS)
        ).length
      : null;

    const productsToConfirm = can("products.confirm")
      ? (
          await ctx.db
            .query("products")
            .withIndex("by_businessUnitId_and_status_and_name", (q) =>
              q.eq("businessUnitId", unit._id).eq("status", "pending_confirmation"),
            )
            .take(MAX_ROWS)
        ).filter((p) => p.createdBy !== ctx.user._id || ctx.isSuperAdmin).length
      : null;

    const requisitionsToBuy = can("stock.create")
      ? (
          await ctx.db
            .query("requisitions")
            .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", "approved"))
            .take(MAX_ROWS)
        ).length
      : null;

    // Credit: what customers still owe (within the sales.view scope).
    let creditOwed: { amount: number; customers: number } | null = null;
    const salesScope = ctx.permissions.get("sales.view");
    if (salesScope !== undefined) {
      const open = (
        await ctx.db
          .query("sales")
          .withIndex("by_businessUnitId_and_creditStatus", (q) => q.eq("businessUnitId", unit._id).eq("creditStatus", "open"))
          .take(MAX_ROWS)
      ).filter((s) => s.customerId && (salesScope === "all_locations" || s.locationId === ctx.user.locationId));
      creditOwed = {
        amount: open.reduce((t, s) => t + saleBalance(s), 0),
        customers: new Set(open.map((s) => s.customerId)).size,
      };
    }

    // Today's sales, and the last day with any when today has none.
    let salesToday: { amount: number; lastSaleDay: string | null } | null = null;
    const analyticsScope = ctx.permissions.get("analytics.view");
    const salesKey =
      salesScope === "all_locations" || analyticsScope === "all_locations" ? ALL : keyFor(salesScope ?? analyticsScope);
    if (salesKey) {
      const [row] = await finance(salesKey, today, today);
      const amount = row?.sales ?? 0;
      let lastSaleDay: string | null = null;
      if (amount === 0) {
        const recent = await finance(salesKey, addBusinessDays(today, -LAST_SALE_LOOKBACK_DAYS), addBusinessDays(today, -1));
        lastSaleDay = recent.filter((r) => r.sales > 0).at(-1)?.day ?? null;
      }
      salesToday = { amount, lastSaleDay };
    }

    // This month's rollup rows per location key (read once per key).
    const monthCache = new Map<string, Awaited<ReturnType<typeof finance>>>();
    const monthRows = async (key: string) => {
      if (!monthCache.has(key)) monthCache.set(key, await finance(key, monthStart(today), today));
      return monthCache.get(key)!;
    };
    const monthSum = async (key: string, f: "payroll" | "withdrawals") =>
      (await monthRows(key)).reduce((t, r) => t + r[f], 0);

    // Payroll and withdrawals this month (with their .view permission), else
    // the caller's own pending requests - totals (salaries) stay private.
    let payroll: { paidThisMonth: number } | { minePending: number } | null = null;
    const payrollKey = keyFor(ctx.permissions.get("payroll.view"));
    if (payrollKey) {
      payroll = { paidThisMonth: await monthSum(payrollKey, "payroll") };
    } else if (can("payroll.create")) {
      const mine = await ctx.db
        .query("payrollEntries")
        .withIndex("by_createdBy", (q) => q.eq("createdBy", ctx.user._id))
        .take(MAX_ROWS);
      payroll = { minePending: mine.filter((e) => e.businessUnitId === unit._id && e.status === "pending").length };
    }
    let withdrawals: { thisMonth: number } | { minePending: number } | null = null;
    const withdrawalsKey = keyFor(ctx.permissions.get("withdrawals.view"));
    if (withdrawalsKey) {
      withdrawals = { thisMonth: await monthSum(withdrawalsKey, "withdrawals") };
    } else if (can("withdrawals.request")) {
      const mine = await ctx.db
        .query("withdrawals")
        .withIndex("by_requestedBy", (q) => q.eq("requestedBy", ctx.user._id))
        .take(MAX_ROWS);
      withdrawals = { minePending: mine.filter((w) => w.businessUnitId === unit._id && w.status === "pending").length };
    }

    // Month to date: sales and net profit (margin - expenses - payroll), analytics.view.
    let monthToDate: { sales: number; netProfit: number } | null = null;
    const analyticsKey = keyFor(analyticsScope);
    if (analyticsKey) {
      const rows = await monthRows(analyticsKey);
      const sum = (f: "sales" | "saleCost" | "expenses" | "payroll") => rows.reduce((t, r) => t + r[f], 0);
      monthToDate = {
        sales: sum("sales"),
        netProfit: sum("sales") - sum("saleCost") - sum("expenses") - sum("payroll"),
      };
    }

    return {
      today,
      currency: "USD" as const,
      approvalsWaiting,
      stock,
      batchesToReceive,
      productsToConfirm,
      requisitionsToBuy,
      requisitionsOpen,
      productsActive,
      payroll,
      withdrawals,
      creditOwed,
      salesToday,
      monthToDate,
    };
  },
});
