// Test-only helpers shared by convex/*.test.ts. Type-only imports from
// convex-test, so this file is harmless if bundled with the deployment.
import type { TestConvex } from "convex-test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";

type T = TestConvex<typeof schema>;

export async function seedRbacForTest(t: T) {
  return await t.mutation(internal.rbac.seedRbac, {});
}

export async function getRoleId(t: T, key: string): Promise<Id<"roles">> {
  const role = await t.run((ctx) =>
    ctx.db
      .query("roles")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  );
  if (!role) {
    throw new Error(`Role "${key}" not seeded - call seedRbacForTest first.`);
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
    }),
  );
}
