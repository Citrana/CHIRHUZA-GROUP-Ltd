import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator } from "./lib/businessUnits";
import { diff } from "./lib/audit";
import { requestApproval } from "./lib/approvals";
import { applyRollupEvents, contractEvents } from "./lib/analytics";
import { nextSequenceNumber } from "./lib/requisitions";
import { addBusinessDays, atClockTimeOn, businessDayOf, isBusinessDay } from "./lib/time";
import {
  CONTRACT_HAS_PAYMENTS,
  applyContractPayment,
  driverCommitted,
  describeContract,
  hasContractPayments,
  paymentStatusOf,
} from "./lib/contracts";
import {
  MAX_CONTRACT_DAYS,
  MAX_NOTE_LENGTH,
  checkCents,
  checkDays,
  cleanText,
  contractBalance,
  contractPaymentStatusValidator,
  daysOverlap,
  endDay,
  requireFleetUnit,
  transportPaymentMethodValidator,
} from "./lib/transport";

/**
 * Transport contracts (CLAUDE.md "Transport"): a car hired by a client for
 * N days at a price per day; the agreed total may differ with a reason.
 * The driver's pay per day is set per contract. Reading needs
 * transport.view; creating, editing and asking to delete
 * transport.contracts.manage. Revenue goes to the rollups spread over the
 * contract's days, in the same mutation.
 */

const MAX_REASON_LENGTH = 300;

/** A required reason, trimmed and bounded. */
function requireReason(value: string | undefined, message: string): string {
  const reason = value?.trim() ?? "";
  if (!reason) throw new ConvexError(message);
  if (reason.length > MAX_REASON_LENGTH) throw new ConvexError("The reason is too long.");
  return reason;
}

/** Refuses a range that overlaps another contract of the car. */
async function checkCarFree(
  ctx: QueryCtx,
  carId: Id<"cars">,
  range: { startDay: string; endDay: string },
  contractId?: Id<"contracts">,
) {
  // A contract that overlaps starts at most MAX_CONTRACT_DAYS - 1 days before.
  const earliest = addBusinessDays(range.startDay, -(MAX_CONTRACT_DAYS - 1));
  const nearby = await ctx.db
    .query("contracts")
    .withIndex("by_carId_and_startDay", (q) => q.eq("carId", carId).gte("startDay", earliest).lte("startDay", range.endDay))
    .take(1000);
  const clash = nearby.find((c) => c._id !== contractId && daysOverlap(c, range));
  if (clash) {
    throw new ConvexError(`${clash.plateNumber} is already hired from ${clash.startDay} to ${clash.endDay} (${clash.number}).`);
  }
}

/** An active driver of the service, or none. */
async function pickDriver(ctx: QueryCtx, unitId: Id<"businessUnits">, driverId: Id<"drivers"> | null) {
  if (!driverId) return null;
  const driver = await ctx.db.get("drivers", driverId);
  if (!driver || driver.businessUnitId !== unitId) throw new ConvexError("Driver not found.");
  if (driver.status !== "active") throw new ConvexError(`${driver.name} is inactive.`);
  return driver;
}

/** The prices: computed total, agreed total (a different one needs a reason), driver total. */
function pricesOf(args: { days: number; dayRate: number; agreedTotal?: number; priceChangeReason?: string; driverDayRate: number }) {
  const dayRate = checkCents(args.dayRate, "The price per day");
  const driverDayRate = checkCents(args.driverDayRate, "The driver's pay per day");
  const computedTotal = dayRate * args.days;
  const totalAmount = args.agreedTotal === undefined ? computedTotal : checkCents(args.agreedTotal, "The total");
  const priceChangeReason =
    totalAmount === computedTotal
      ? undefined
      : requireReason(args.priceChangeReason, "Say why the total differs from price per day × days.");
  return { dayRate, computedTotal, totalAmount, priceChangeReason, driverDayRate, driverPayTotal: driverDayRate * args.days };
}

/** A payment date: today or earlier (YYYY-MM-DD), as UTC ms at the recording's clock time. */
export function paidAtFor(paidOn: string | undefined, now: number): number {
  if (paidOn === undefined) return now;
  if (!isBusinessDay(paidOn)) throw new ConvexError("The payment date must be YYYY-MM-DD.");
  if (paidOn > businessDayOf(now)) throw new ConvexError("A payment can't be dated in the future.");
  return atClockTimeOn(paidOn, now);
}

const listArgs = {
  businessUnitKey: businessUnitKeyValidator,
  // Contracts starting in this range of business days (YYYY-MM-DD).
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  carId: v.optional(v.id("cars")),
  clientId: v.optional(v.id("clients")),
  paymentStatus: v.optional(contractPaymentStatusValidator),
  paginationOpts: paginationOptsValidator,
};

/** Contracts, latest start first, with what the client still owes. */
export const list = authedQuery({
  args: listArgs,
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.view");
    const unit = await requireFleetUnit(ctx, args.businessUnitKey);
    for (const day of [args.from, args.to]) {
      if (day !== undefined && !isBusinessDay(day)) throw new ConvexError("Dates must be YYYY-MM-DD.");
    }
    const { from, to, carId, clientId, paymentStatus } = args;
    const base = carId
      ? ctx.db.query("contracts").withIndex("by_carId_and_startDay", (q) => {
          const eq = q.eq("carId", carId);
          const lower = from ? eq.gte("startDay", from) : eq;
          return to ? lower.lte("startDay", to) : lower;
        })
      : clientId
        ? ctx.db.query("contracts").withIndex("by_clientId_and_startDay", (q) => {
            const eq = q.eq("clientId", clientId);
            const lower = from ? eq.gte("startDay", from) : eq;
            return to ? lower.lte("startDay", to) : lower;
          })
        : ctx.db.query("contracts").withIndex("by_businessUnitId_and_startDay", (q) => {
            const eq = q.eq("businessUnitId", unit._id);
            const lower = from ? eq.gte("startDay", from) : eq;
            return to ? lower.lte("startDay", to) : lower;
          });
    // Filters the chosen index can't express.
    const filtered = base.order("desc").filter((q) => {
      const checks = [q.eq(q.field("businessUnitId"), unit._id)];
      if (carId && clientId) checks.push(q.eq(q.field("clientId"), clientId));
      if (paymentStatus) checks.push(q.eq(q.field("paymentStatus"), paymentStatus));
      return q.and(...checks);
    });
    const result = await filtered.paginate(args.paginationOpts);
    return { ...result, page: result.page.map((c) => ({ ...c, balance: contractBalance(c) })) };
  },
});

/** One contract with its client payments (and pending corrections) and driver payments. */
export const get = authedQuery({
  args: { contractId: v.id("contracts") },
  handler: async (ctx, { contractId }) => {
    await ctx.requirePermission("transport.view");
    const contract = await ctx.db.get("contracts", contractId);
    if (!contract) return null;
    const pendingOn = async (entityTable: string, entityId: string) =>
      (
        await ctx.db
          .query("approvals")
          .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", entityTable).eq("entityId", entityId))
          .take(20)
      ).some((a) => a.status === "pending");
    const rows = await ctx.db.query("contractPayments").withIndex("by_contractId", (q) => q.eq("contractId", contractId)).take(500);
    const reversed = new Set(rows.flatMap((p) => (p.reversesPaymentId ? [p.reversesPaymentId] : [])));
    const payments = await Promise.all(
      rows.map(async (p) => {
        const recorder = await ctx.db.get("users", p.recordedBy);
        return {
          ...p,
          recordedByName: recorder?.name || recorder?.email || null,
          reversed: reversed.has(p._id),
          reversalPending: p.kind === "payment" && !reversed.has(p._id) ? await pendingOn("contractPayments", p._id) : false,
        };
      }),
    );
    const driverRows = await ctx.db.query("driverPayments").withIndex("by_contractId", (q) => q.eq("contractId", contractId)).take(500);
    const driverPayments = await Promise.all(
      driverRows.map(async (p) => {
        const [requester, approval] = await Promise.all([
          ctx.db.get("users", p.requestedBy),
          p.approvalId ? ctx.db.get("approvals", p.approvalId) : null,
        ]);
        const decider = approval?.decidedBy ? await ctx.db.get("users", approval.decidedBy) : null;
        return {
          ...p,
          requestedByName: requester?.name || requester?.email || null,
          decidedByName: decider?.name || decider?.email || null,
          decisionNote: approval?.decisionNote ?? null,
        };
      }),
    );
    const driverPending = driverRows.filter((p) => p.status === "pending").reduce((s, p) => s + p.amount, 0);
    const client = await ctx.db.get("clients", contract.clientId);
    return {
      ...contract,
      balance: contractBalance(contract),
      client: client
        ? {
            _id: client._id,
            kind: client.kind,
            name: client.name,
            contactName: client.contactName ?? null,
            phone: client.phone ?? null,
            email: client.email ?? null,
            address: client.address ?? null,
          }
        : null,
      carModel: (await ctx.db.get("cars", contract.carId))?.model ?? null,
      payments: payments.sort((a, b) => b.paidAt - a.paidAt),
      driverPayments: driverPayments.sort((a, b) => b.paidAt - a.paidAt),
      driverPending,
      // What the driver can still be paid (approved and pending count).
      driverOwed: contract.driverPayTotal - contract.driverPaid - driverPending,
      deletePending: await pendingOn("contracts", contract._id),
    };
  },
});

const priceArgs = {
  startDay: v.string(),
  days: v.number(),
  dayRate: v.number(),
  // The agreed total (cents); missing = dayRate x days. A different one needs priceChangeReason.
  agreedTotal: v.optional(v.number()),
  priceChangeReason: v.optional(v.string()),
  driverDayRate: v.number(),
  note: v.optional(v.string()),
};

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    carId: v.id("cars"),
    clientId: v.id("clients"),
    ...priceArgs,
    // What the client paid at signing (optional).
    firstPayment: v.optional(
      v.object({ amount: v.number(), method: transportPaymentMethodValidator, paidOn: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.contracts.manage");
    const unit = await requireFleetUnit(ctx, args.businessUnitKey);
    const car = await ctx.db.get("cars", args.carId);
    if (!car || car.businessUnitId !== unit._id) throw new ConvexError("Car not found.");
    if (car.status !== "active") throw new ConvexError(`${car.plateNumber} is retired.`);
    const client = await ctx.db.get("clients", args.clientId);
    if (!client || client.businessUnitId !== unit._id) throw new ConvexError("Client not found.");
    const days = checkDays(args.days);
    const range = { startDay: args.startDay, endDay: endDay(args.startDay, days) };
    await checkCarFree(ctx, car._id, range);
    const driver = await pickDriver(ctx, unit._id, car.driverId ?? null);
    const prices = pricesOf({ ...args, days });
    const note = cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH });
    const now = Date.now();
    const paidAt = args.firstPayment ? paidAtFor(args.firstPayment.paidOn, now) : undefined;

    const number = await nextSequenceNumber(ctx, unit._id, "contract", "CONTRACT");
    const contractId = await ctx.db.insert("contracts", {
      businessUnitId: unit._id,
      number,
      carId: car._id,
      plateNumber: car.plateNumber,
      clientId: client._id,
      clientName: client.name,
      ...(driver ? { driverId: driver._id, driverName: driver.name } : {}),
      ...range,
      days,
      ...prices,
      amountPaid: 0,
      paymentStatus: paymentStatusOf(prices.totalAmount, 0),
      driverPaid: 0,
      currency: "USD",
      note,
      createdBy: ctx.user._id,
      createdAt: now,
    });
    const contract = (await ctx.db.get("contracts", contractId))!;
    await ctx.audit({
      action: "create",
      entityTable: "contracts",
      entityId: contractId,
      businessUnitId: unit._id,
      after: describeContract(contract),
    });
    // The client now owes the total; revenue spreads over the contract's days.
    await ctx.db.patch("clients", client._id, { balance: client.balance + prices.totalAmount });
    await ctx.audit({
      action: "update",
      entityTable: "clients",
      entityId: client._id,
      businessUnitId: unit._id,
      before: { name: client.name, balanceAmount: client.balance, currency: "USD" },
      after: { name: client.name, balanceAmount: client.balance + prices.totalAmount, currency: "USD", contract: number },
    });
    await applyRollupEvents(ctx, unit._id, contractEvents(contract));

    if (args.firstPayment && args.firstPayment.amount > 0) {
      checkCents(args.firstPayment.amount, "The payment");
      await applyContractPayment(ctx, {
        contract,
        amount: args.firstPayment.amount,
        method: args.firstPayment.method,
        kind: "payment",
        paidAt: paidAt!,
        actorId: ctx.user._id,
      });
    }
    return { contractId, number };
  },
});

/**
 * Edits a contract (dates, days, prices, driver, note) with a reason. The
 * car stays the same. The new total can't go below what the client paid,
 * nor the driver's total below what they were paid. Rollups and the
 * client's balance follow.
 */
export const update = authedMutation({
  args: {
    contractId: v.id("contracts"),
    ...priceArgs,
    driverId: v.union(v.id("drivers"), v.null()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.contracts.manage");
    const contract = await ctx.db.get("contracts", args.contractId);
    if (!contract) throw new ConvexError("Contract not found.");
    const reason = requireReason(args.reason, "Say why the contract changes.");
    const days = checkDays(args.days);
    const range = { startDay: args.startDay, endDay: endDay(args.startDay, days) };
    await checkCarFree(ctx, contract.carId, range, contract._id);
    const driver =
      args.driverId === (contract.driverId ?? null)
        ? args.driverId
          ? { _id: args.driverId, name: contract.driverName ?? "" }
          : null
        : await pickDriver(ctx, contract.businessUnitId, args.driverId);
    const prices = pricesOf({ ...args, days });
    if (prices.totalAmount < contract.amountPaid) {
      throw new ConvexError("The new total is less than what the client already paid.");
    }
    if (prices.driverPayTotal < (await driverCommitted(ctx, contract._id))) {
      throw new ConvexError("The driver's new total is less than what they were already paid (or asked for).");
    }
    const next: Doc<"contracts"> = {
      ...contract,
      ...range,
      days,
      ...prices,
      driverId: driver?._id,
      driverName: driver?.name,
      paymentStatus: paymentStatusOf(prices.totalAmount, contract.amountPaid),
      note: cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH }),
    };
    const changes = diff(describeContract(contract), describeContract(next));
    if (!changes) return;
    const { _id, _creationTime, ...fields } = next;
    void _creationTime;
    // `undefined` removes a cleared driver, reason or note.
    await ctx.db.patch("contracts", _id, fields);
    await ctx.audit({
      action: "update",
      entityTable: "contracts",
      entityId: _id,
      businessUnitId: contract.businessUnitId,
      before: { number: contract.number, ...changes.before },
      after: { number: contract.number, ...changes.after },
      reason,
    });
    // Revenue: the old spread out, the new one in.
    await applyRollupEvents(ctx, contract.businessUnitId, [...contractEvents(contract, -1), ...contractEvents(next)]);
    const delta = prices.totalAmount - contract.totalAmount;
    if (delta !== 0) {
      const client = await ctx.db.get("clients", contract.clientId);
      if (client) {
        await ctx.db.patch("clients", client._id, { balance: client.balance + delta });
        await ctx.audit({
          action: "update",
          entityTable: "clients",
          entityId: client._id,
          businessUnitId: contract.businessUnitId,
          before: { name: client.name, balanceAmount: client.balance, currency: "USD" },
          after: { name: client.name, balanceAmount: client.balance + delta, currency: "USD", contract: contract.number },
        });
      }
    }
  },
});

/** Asks to delete a contract that has no payments (approval type "delete"). */
export const requestDelete = authedMutation({
  args: { contractId: v.id("contracts"), reason: v.string() },
  handler: async (ctx, { contractId, reason }) => {
    await ctx.requirePermission("transport.contracts.manage");
    const contract = await ctx.db.get("contracts", contractId);
    if (!contract) throw new ConvexError("Contract not found.");
    const cleanReason = requireReason(reason, "Say why this contract should be deleted.");
    if (contract.amountPaid !== 0 || contract.driverPaid !== 0 || (await hasContractPayments(ctx, contractId))) {
      throw new ConvexError(CONTRACT_HAS_PAYMENTS);
    }
    const pending = (
      await ctx.db
        .query("approvals")
        .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", "contracts").eq("entityId", contractId))
        .take(20)
    ).some((a) => a.status === "pending");
    if (pending) throw new ConvexError("A delete is already waiting for approval.");
    return await requestApproval(ctx, {
      type: "delete",
      businessUnitId: contract.businessUnitId,
      entityTable: "contracts",
      entityId: contractId,
      payload: { before: describeContract(contract) },
      reason: cleanReason,
    });
  },
});
