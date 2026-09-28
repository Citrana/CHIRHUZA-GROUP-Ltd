// Test-only helpers shared by convex/*.test.ts. The two dots in the file
// name are deliberate: the Convex CLI skips files with more than one dot,
// so this never gets pushed to a deployment (a hyphenated name like
// test-utils.ts would be pushed and rejected as an invalid module path).
import type { TestConvex } from "convex-test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";
import type { BusinessUnitKey } from "./businessUnits";

type T = TestConvex<typeof schema>;

/** Seeds RBAC and business units, like `seed:seedReferenceData`. */
export async function seedReferenceDataForTest(t: T) {
  const result = await t.mutation(internal.rbac.seedRbac, {});
  await t.mutation(internal.businessUnits.seedBusinessUnits, {});
  return result;
}

export async function getBusinessUnitId(
  t: T,
  key: BusinessUnitKey,
): Promise<Id<"businessUnits">> {
  const unit = await t.run((ctx) =>
    ctx.db
      .query("businessUnits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  );
  if (!unit) {
    throw new Error(`Business unit "${key}" not seeded.`);
  }
  return unit._id;
}

export async function insertLocation(
  t: T,
  overrides: Partial<{
    businessUnit: BusinessUnitKey;
    name: string;
    type: "shop" | "warehouse";
    active: boolean;
  }> = {},
): Promise<Id<"locations">> {
  const businessUnitId = await getBusinessUnitId(
    t,
    overrides.businessUnit ?? "hair",
  );
  return await t.run((ctx) =>
    ctx.db.insert("locations", {
      businessUnitId,
      name: overrides.name ?? "Main shop",
      type: overrides.type ?? "shop",
      address: "1 Test Avenue",
      active: overrides.active ?? true,
    }),
  );
}

export async function getRoleId(t: T, key: string): Promise<Id<"roles">> {
  const role = await t.run((ctx) =>
    ctx.db
      .query("roles")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  );
  if (!role) {
    throw new Error(
      `Role "${key}" not seeded - call seedReferenceDataForTest first.`,
    );
  }
  return role._id;
}

/** Inserts a user holding the given role (seeded roles only), or no role. */
export async function insertUserWithRole(
  t: T,
  roleKey: string | null,
  overrides: Partial<{
    name: string;
    email: string;
    status: "active" | "blocked";
    mustChangePassword: boolean;
    createdBy: Id<"users"> | null;
    locationId: Id<"locations">;
  }> = {},
): Promise<Id<"users">> {
  const roleId = roleKey === null ? null : await getRoleId(t, roleKey);
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? "Test User",
      email: overrides.email ?? "user@example.com",
      roleId,
      status: overrides.status ?? "active",
      mustChangePassword: overrides.mustChangePassword ?? false,
      createdBy: overrides.createdBy ?? null,
      ...(overrides.locationId ? { locationId: overrides.locationId } : {}),
    }),
  );
}
