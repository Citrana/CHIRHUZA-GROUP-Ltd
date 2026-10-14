import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator } from "./lib/businessUnits";
import { diff } from "./lib/audit";
import {
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PLATE_LENGTH,
  carStatusValidator,
  cleanPlate,
  cleanText,
  plateKey,
  requireFleetUnit,
} from "./lib/transport";

/**
 * The fleet (convex/lib/transport.ts): cars known by their plate (unique
 * per service), each with one driver - and a driver drives one car at a
 * time. Viewing needs transport.view; adding and editing
 * transport.fleet.manage. Never deleted - retired instead.
 */

const MAX_CARS = 500;

/** An audit snapshot, with the driver's name next to the id. */
async function snapshot(
  ctx: QueryCtx,
  car: Pick<Doc<"cars">, "plateNumber" | "model" | "driverId" | "status" | "note">,
) {
  const driver = car.driverId ? await ctx.db.get("drivers", car.driverId) : null;
  return {
    plateNumber: car.plateNumber,
    model: car.model,
    driverId: car.driverId ?? null,
    driverName: driver?.name ?? null,
    status: car.status,
    note: car.note ?? null,
  };
}

/** A plate that's well formed and not taken by another car of the service. */
async function checkPlate(ctx: QueryCtx, unitId: Id<"businessUnits">, plate: string, carId?: Id<"cars">) {
  const plateNumber = cleanPlate(plate);
  const key = plateKey(plate);
  if (!key) throw new ConvexError("The plate number is required.");
  if (plateNumber.length > MAX_PLATE_LENGTH) throw new ConvexError("The plate number is too long.");
  const taken = await ctx.db
    .query("cars")
    .withIndex("by_businessUnitId_and_plateKey", (q) => q.eq("businessUnitId", unitId).eq("plateKey", key))
    .first();
  if (taken && taken._id !== carId) throw new ConvexError(`Another car already has the plate ${taken.plateNumber}.`);
  return { plateNumber, plateKey: key };
}

/** An active driver of the service who doesn't drive another active car. */
async function checkDriver(ctx: QueryCtx, unitId: Id<"businessUnits">, driverId: Id<"drivers">, carId?: Id<"cars">) {
  const driver = await ctx.db.get("drivers", driverId);
  if (!driver || driver.businessUnitId !== unitId) throw new ConvexError("Driver not found.");
  if (driver.status !== "active") throw new ConvexError(`${driver.name} is inactive.`);
  const other = (
    await ctx.db
      .query("cars")
      .withIndex("by_driverId", (q) => q.eq("driverId", driverId))
      .take(20)
  ).find((c) => c.status === "active" && c._id !== carId);
  if (other) throw new ConvexError(`${driver.name} already drives ${other.plateNumber}.`);
}

/** The service's cars (active first, then by plate), with their driver. */
export const list = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("transport.view");
    const unit = await requireFleetUnit(ctx, businessUnitKey);
    const cars = await ctx.db
      .query("cars")
      .withIndex("by_businessUnitId_and_plateKey", (q) => q.eq("businessUnitId", unit._id))
      .take(MAX_CARS);
    const rows = await Promise.all(
      cars.map(async (car) => {
        const driver = car.driverId ? await ctx.db.get("drivers", car.driverId) : null;
        return {
          ...car,
          driverName: driver?.name ?? null,
          driverPhone: driver?.phone ?? null,
          driverDayRate: driver?.dayRate ?? null,
        };
      }),
    );
    return rows.sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
  },
});

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    plateNumber: v.string(),
    model: v.string(),
    driverId: v.optional(v.id("drivers")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.fleet.manage");
    const unit = await requireFleetUnit(ctx, args.businessUnitKey);
    const plate = await checkPlate(ctx, unit._id, args.plateNumber);
    if (args.driverId) await checkDriver(ctx, unit._id, args.driverId);
    const fields = {
      plateNumber: plate.plateNumber,
      model: cleanText(args.model, { label: "Model", max: MAX_NAME_LENGTH, required: true })!,
      driverId: args.driverId,
      status: "active" as const,
      note: cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH }),
    };
    const carId = await ctx.db.insert("cars", {
      businessUnitId: unit._id,
      ...fields,
      plateKey: plate.plateKey,
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });
    await ctx.audit({
      action: "create",
      entityTable: "cars",
      entityId: carId,
      businessUnitId: unit._id,
      after: await snapshot(ctx, fields),
    });
    return carId;
  },
});

/** Edits a car: plate, model, driver (null = none), note, or retires / brings it back. */
export const update = authedMutation({
  args: {
    carId: v.id("cars"),
    plateNumber: v.string(),
    model: v.string(),
    driverId: v.union(v.id("drivers"), v.null()),
    note: v.optional(v.string()),
    status: carStatusValidator,
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.fleet.manage");
    const car = await ctx.db.get("cars", args.carId);
    if (!car) throw new ConvexError("Car not found.");
    const plate = await checkPlate(ctx, car.businessUnitId, args.plateNumber, car._id);
    // A retired car frees its driver; one coming back must not share theirs.
    if (args.driverId && args.status === "active") await checkDriver(ctx, car.businessUnitId, args.driverId, car._id);
    const next = {
      plateNumber: plate.plateNumber,
      model: cleanText(args.model, { label: "Model", max: MAX_NAME_LENGTH, required: true })!,
      driverId: args.driverId ?? undefined,
      status: args.status,
      note: cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH }),
    };
    const changes = diff(await snapshot(ctx, car), await snapshot(ctx, next));
    if (!changes) return;
    // `undefined` removes a cleared driver or note.
    await ctx.db.patch("cars", car._id, { ...next, plateKey: plate.plateKey });
    await ctx.audit({
      action: "update",
      entityTable: "cars",
      entityId: car._id,
      businessUnitId: car.businessUnitId,
      before: { plateNumber: car.plateNumber, ...changes.before },
      after: { plateNumber: next.plateNumber, ...changes.after },
    });
  },
});
