import { v, ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator } from "./lib/businessUnits";
import { diff } from "./lib/audit";
import {
  MAX_NAME_LENGTH,
  checkDayRate,
  cleanText,
  driverStatusValidator,
  requireFleetUnit,
} from "./lib/transport";

/**
 * Drivers (convex/lib/transport.ts): records, not app users. Viewing needs
 * transport.view; adding and editing transport.fleet.manage. Never deleted
 * - set inactive instead.
 */

const MAX_DRIVERS = 500;
const MAX_PHONE_LENGTH = 30;

/** An audit snapshot (day rate as a money field). */
const snapshot = (d: Pick<Doc<"drivers">, "name" | "phone" | "dayRate" | "status">) => ({
  name: d.name,
  phone: d.phone ?? null,
  dayRateAmount: d.dayRate,
  currency: "USD",
  status: d.status,
});

/** The service's drivers, by name (active first), with the car each drives. */
export const list = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("transport.view");
    const unit = await requireFleetUnit(ctx, businessUnitKey);
    const drivers = await ctx.db
      .query("drivers")
      .withIndex("by_businessUnitId_and_name", (q) => q.eq("businessUnitId", unit._id))
      .take(MAX_DRIVERS);
    const rows = await Promise.all(
      drivers.map(async (driver) => {
        const car = (
          await ctx.db
            .query("cars")
            .withIndex("by_driverId", (q) => q.eq("driverId", driver._id))
            .take(20)
        ).find((c) => c.status === "active");
        return { ...driver, carPlate: car?.plateNumber ?? null };
      }),
    );
    return rows.sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
  },
});

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    name: v.string(),
    phone: v.optional(v.string()),
    dayRate: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.fleet.manage");
    const unit = await requireFleetUnit(ctx, args.businessUnitKey);
    const name = cleanText(args.name, { label: "Name", max: MAX_NAME_LENGTH, required: true })!;
    const phone = cleanText(args.phone, { label: "Phone", max: MAX_PHONE_LENGTH });
    const dayRate = checkDayRate(args.dayRate);
    const fields = { name, phone, dayRate, status: "active" as const };
    const driverId = await ctx.db.insert("drivers", {
      businessUnitId: unit._id,
      ...fields,
      currency: "USD",
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });
    await ctx.audit({
      action: "create",
      entityTable: "drivers",
      entityId: driverId,
      businessUnitId: unit._id,
      after: snapshot(fields),
    });
    return driverId;
  },
});

export const update = authedMutation({
  args: {
    driverId: v.id("drivers"),
    name: v.string(),
    phone: v.optional(v.string()),
    dayRate: v.number(),
    status: driverStatusValidator,
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.fleet.manage");
    const driver = await ctx.db.get("drivers", args.driverId);
    if (!driver) throw new ConvexError("Driver not found.");
    const next = {
      name: cleanText(args.name, { label: "Name", max: MAX_NAME_LENGTH, required: true })!,
      phone: cleanText(args.phone, { label: "Phone", max: MAX_PHONE_LENGTH }),
      dayRate: checkDayRate(args.dayRate),
      status: args.status,
    };
    if (driver.status === "active" && next.status === "inactive") {
      const car = (
        await ctx.db
          .query("cars")
          .withIndex("by_driverId", (q) => q.eq("driverId", driver._id))
          .take(20)
      ).find((c) => c.status === "active");
      if (car) throw new ConvexError(`${driver.name} drives ${car.plateNumber}: give that car another driver first.`);
    }
    const changes = diff(snapshot(driver), snapshot(next));
    if (!changes) return;
    // `undefined` removes a cleared phone.
    await ctx.db.patch("drivers", driver._id, next);
    await ctx.audit({
      action: "update",
      entityTable: "drivers",
      entityId: driver._id,
      businessUnitId: driver.businessUnitId,
      before: { name: driver.name, ...changes.before },
      after: { name: next.name, ...changes.after },
    });
  },
});
