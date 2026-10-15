import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { cleanPlate, plateKey } from "./lib/transport";
import { insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Manager" });
  const superAdmin = await insertUserWithRole(t, "super_admin", { email: "sa@x.com", name: "Owner" });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  const addDriver = (name: string, who = chief) => as(who).mutation(api.drivers.create, { businessUnitKey: "transport", name });
  const addCar = (plateNumber: string, driverId?: Id<"drivers">, who = chief) =>
    as(who).mutation(api.cars.create, {
      businessUnitKey: "transport",
      plateNumber,
      model: "Land Cruiser",
      ...(driverId ? { driverId } : {}),
    });
  const audits = (table: string) =>
    t.run((ctx) => ctx.db.query("auditLogs").collect()).then((rows) => rows.filter((r) => r.entityTable === table));
  return { t, chief, manager, superAdmin, as, addDriver, addCar, audits };
}

test("plates: trimmed and upper-cased; spaces and dashes don't make a new plate", () => {
  expect(cleanPlate("  5432  ab 07 ")).toBe("5432 AB 07");
  expect(plateKey("5432 ab-07")).toBe("5432AB07");
});

test("the Chief Admin adds drivers and cars; others can't, and only Transport has cars", async () => {
  const s = await setup();
  const jean = await s.addDriver("  Jean   Mukendi ");
  const car = await s.addCar("5432 ab 07", jean);

  expect(await s.as(s.chief).query(api.cars.list, { businessUnitKey: "transport" })).toMatchObject([
    { _id: car, plateNumber: "5432 AB 07", model: "Land Cruiser", driverName: "Jean Mukendi", status: "active" },
  ]);
  expect(await s.as(s.chief).query(api.drivers.list, { businessUnitKey: "transport" })).toMatchObject([
    { name: "Jean Mukendi", carPlate: "5432 AB 07", status: "active" },
  ]);

  // Audited, with readable names.
  expect((await s.audits("cars"))[0]).toMatchObject({ action: "create", after: { plateNumber: "5432 AB 07", driverName: "Jean Mukendi" } });
  expect((await s.audits("drivers"))[0]).toMatchObject({ action: "create", after: { name: "Jean Mukendi", phone: null, status: "active" } });

  // No transport permissions by default for other roles.
  await expect(s.addDriver("Paul", s.manager)).rejects.toThrow(/transport\.fleet\.manage/);
  await expect(s.as(s.manager).query(api.cars.list, { businessUnitKey: "transport" })).rejects.toThrow(/transport\.view/);
  // Hair runs no fleet.
  await expect(s.as(s.chief).query(api.cars.list, { businessUnitKey: "hair" })).rejects.toThrow(/no cars/);
  // The Super Admin can do everything.
  await s.addCar("1111 AA 01", undefined, s.superAdmin);
});

test("a plate is unique per service; a driver drives one active car", async () => {
  const s = await setup();
  const jean = await s.addDriver("Jean");
  const paul = await s.addDriver("Paul");
  const first = await s.addCar("5432 AB 07", jean);
  await expect(s.addCar("5432-ab07")).rejects.toThrow(/already has the plate 5432 AB 07/);
  await expect(s.addCar("9999 ZZ 01", jean)).rejects.toThrow(/Jean already drives 5432 AB 07/);
  await expect(s.addCar("  ")).rejects.toThrow(/plate number is required/);

  const second = await s.addCar("9999 ZZ 01", paul);
  // Retiring the first car frees Jean; the second car can then take him.
  const edit = (carId: Id<"cars">, fields: Partial<{ plateNumber: string; driverId: Id<"drivers"> | null; status: "active" | "retired" }>) =>
    s.as(s.chief).mutation(api.cars.update, {
      carId,
      plateNumber: fields.plateNumber ?? (carId === first ? "5432 AB 07" : "9999 ZZ 01"),
      model: "Land Cruiser",
      driverId: fields.driverId === undefined ? null : fields.driverId,
      status: fields.status ?? "active",
    });
  await expect(edit(second, { driverId: jean })).rejects.toThrow(/Jean already drives/);
  await edit(first, { driverId: jean, status: "retired" });
  await edit(second, { driverId: jean });
  // Bringing the first car back with Jean is refused: he drives the second now.
  await expect(edit(first, { driverId: jean })).rejects.toThrow(/Jean already drives 9999 ZZ 01/);
  // Renaming onto another car's plate is refused; keeping your own is fine.
  await expect(edit(second, { plateNumber: "5432AB07", driverId: jean })).rejects.toThrow(/already has the plate/);

  const cars = await s.as(s.chief).query(api.cars.list, { businessUnitKey: "transport" });
  expect(cars.map((c) => [c.plateNumber, c.status, c.driverName])).toEqual([
    ["9999 ZZ 01", "active", "Jean"],
    ["5432 AB 07", "retired", "Jean"],
  ]);
  // Updates only log what changed.
  const updates = (await s.audits("cars")).filter((a) => a.action === "update");
  expect(updates.map((u) => u.after)).toEqual([
    { plateNumber: "5432 AB 07", status: "retired" },
    { plateNumber: "9999 ZZ 01", driverId: jean, driverName: "Jean" },
  ]);
});

test("drivers: edits are audited; one who drives an active car can't be made inactive", async () => {
  const s = await setup();
  const jean = await s.addDriver("Jean");
  await s.addCar("5432 AB 07", jean);
  const edit = (fields: Partial<{ status: "active" | "inactive"; phone: string }>) =>
    s.as(s.chief).mutation(api.drivers.update, {
      driverId: jean,
      name: "Jean",
      status: fields.status ?? "active",
      ...(fields.phone ? { phone: fields.phone } : {}),
    });
  await edit({ phone: "+243 900 000 000" });
  expect((await s.audits("drivers")).at(-1)).toMatchObject({
    action: "update",
    before: { name: "Jean", phone: null },
    after: { name: "Jean", phone: "+243 900 000 000" },
  });
  await expect(edit({ phone: "+243 900 000 000", status: "inactive" })).rejects.toThrow(/drives 5432 AB 07/);
  // An inactive driver can't be given a car.
  const paul = await s.addDriver("Paul");
  await s.as(s.chief).mutation(api.drivers.update, { driverId: paul, name: "Paul", status: "inactive" });
  await expect(s.addCar("1111 AA 01", paul)).rejects.toThrow(/Paul is inactive/);
});
