import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./lib/permissions";
import { requirePermission } from "./lib/rbac";
import {
  getRoleId,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

const PRODUCTS_AND_WITHDRAWALS = [
  "products.view",
  "products.manage",
  "withdrawals.view",
  "withdrawals.request",
] as const;

const SALES_AGENT_DEFAULTS = {
  "sales.view": "own_location",
  "sales.create": "own_location",
  "sales.edit.request": "own_location",
  "payroll.create": "own_location",
  ...Object.fromEntries(
    PRODUCTS_AND_WITHDRAWALS.map((k) => [k, "own_location"]),
  ),
};

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  return t;
}

async function counts(t: Awaited<ReturnType<typeof setup>>) {
  return await t.run(async (ctx) => ({
    permissions: (await ctx.db.query("permissions").collect()).length,
    roles: (await ctx.db.query("roles").collect()).length,
    rolePermissions: (await ctx.db.query("rolePermissions").collect()).length,
  }));
}

test("seedRbac seeds the catalog and six system roles, idempotently", async () => {
  const t = await setup();
  const first = await counts(t);
  expect(first.permissions).toBe(PERMISSIONS.length);
  expect(first.roles).toBe(6);

  await t.mutation(internal.rbac.seedRbac, {});
  expect(await counts(t)).toEqual(first);
});

test("re-seeding keeps a Super Admin's edits to non-locked roles", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const agentRoleId = await getRoleId(t, "sales_agent");
  await t.withIdentity({ subject: adminId }).mutation(api.rbac.setRolePermission, {
    roleId: agentRoleId,
    permissionKey: "sales.edit.request",
    scope: null,
  });

  await t.mutation(internal.rbac.seedRbac, {});

  const agentId = await insertUserWithRole(t, "sales_agent", { email: "g@x.com" });
  const perms = await t
    .withIdentity({ subject: agentId })
    .query(api.rbac.getMyPermissions, {});
  const expected: Record<string, string> = { ...SALES_AGENT_DEFAULTS };
  delete expected["sales.edit.request"];
  expect(perms).toEqual(expected);
});

test("seedRbac moves a legacy isSuperAdmin user onto the Super Admin role", async () => {
  const t = await setup();
  const legacyId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Legacy",
      email: "legacy@x.com",
      roleId: null,
      status: "active",
      mustChangePassword: false,
      isSuperAdmin: true,
      createdBy: null,
    }),
  );
  await t.mutation(internal.rbac.seedRbac, {});
  const legacy = await t.run((ctx) => ctx.db.get("users", legacyId));
  expect(legacy?.roleId).toBe(await getRoleId(t, "super_admin"));
});

test("getMyPermissions: Super Admin has everything, Sales Agent only its own-location defaults, anonymous nothing", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const agentId = await insertUserWithRole(t, "sales_agent", { email: "g@x.com" });

  const adminPerms = await t
    .withIdentity({ subject: adminId })
    .query(api.rbac.getMyPermissions, {});
  expect(Object.keys(adminPerms).sort()).toEqual(
    PERMISSIONS.map((p) => p.key).sort(),
  );

  const agentPerms = await t
    .withIdentity({ subject: agentId })
    .query(api.rbac.getMyPermissions, {});
  expect(agentPerms).toEqual(SALES_AGENT_DEFAULTS);

  expect(await t.query(api.rbac.getMyPermissions, {})).toEqual({});
});

test("a user without the permission is rejected by the server", async () => {
  const t = await setup();
  const agentId = await insertUserWithRole(t, "sales_agent", { email: "g@x.com" });
  const noRoleId = await insertUserWithRole(t, null, { email: "n@x.com" });

  for (const userId of [agentId, noRoleId]) {
    const asUser = t.withIdentity({ subject: userId });
    await expect(asUser.query(api.users.listUsers, {})).rejects.toThrow(
      /users\.manage/,
    );
    await expect(asUser.query(api.rbac.listRoles, {})).rejects.toThrow(
      /roles\.manage/,
    );
  }
  await expect(t.query(api.rbac.listRoles, {})).rejects.toThrow(
    /Not authenticated/,
  );
});

test("a permission granted to a role takes effect immediately, and revoking removes it", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const agentId = await insertUserWithRole(t, "sales_agent", { email: "g@x.com" });
  const agentRoleId = await getRoleId(t, "sales_agent");
  const asAdmin = t.withIdentity({ subject: adminId });
  const asAgent = t.withIdentity({ subject: agentId });

  await expect(asAgent.query(api.users.listUsers, {})).rejects.toThrow();

  await asAdmin.mutation(api.rbac.setRolePermission, {
    roleId: agentRoleId,
    permissionKey: "users.manage",
    scope: "all_locations",
  });
  expect(await asAgent.query(api.users.listUsers, {})).toHaveLength(2);

  await asAdmin.mutation(api.rbac.setRolePermission, {
    roleId: agentRoleId,
    permissionKey: "users.manage",
    scope: null,
  });
  await expect(asAgent.query(api.users.listUsers, {})).rejects.toThrow();

  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs.map((l) => [l.action, l.entityTable])).toEqual([
    ["create", "rolePermissions"],
    ["delete", "rolePermissions"],
  ]);
  const grant = {
    roleId: agentRoleId,
    role: "sales_agent",
    permission: "users.manage",
    scope: "all_locations",
  };
  expect(logs[0]).toMatchObject({ actorId: adminId, after: grant });
  expect(logs[1]).toMatchObject({ actorId: adminId, before: grant });
  // The revoke deletes the same row the grant created.
  expect(logs[1].entityId).toBe(logs[0].entityId);
});

test("setRolePermission changes scope and audits it", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const agentRoleId = await getRoleId(t, "sales_agent");

  await t.withIdentity({ subject: adminId }).mutation(api.rbac.setRolePermission, {
    roleId: agentRoleId,
    permissionKey: "sales.create",
    scope: "all_locations",
  });

  const role = await t
    .withIdentity({ subject: adminId })
    .query(api.rbac.getRole, { roleId: agentRoleId });
  const sales = role!.modules.find((m) => m.module === "sales")!;
  expect(sales.permissions.find((p) => p.key === "sales.create")?.scope).toBe(
    "all_locations",
  );
  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs[0]).toMatchObject({
    action: "update",
    entityTable: "rolePermissions",
    before: { permission: "sales.create", scope: "own_location" },
    after: { permission: "sales.create", scope: "all_locations" },
  });
});

test("setRolePermission rejects the locked Super Admin role, unknown keys, and non-admins", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const chiefId = await insertUserWithRole(t, "chief_admin", { email: "c@x.com" });
  const superAdminRoleId = await getRoleId(t, "super_admin");
  const agentRoleId = await getRoleId(t, "sales_agent");
  const asAdmin = t.withIdentity({ subject: adminId });

  await expect(
    asAdmin.mutation(api.rbac.setRolePermission, {
      roleId: superAdminRoleId,
      permissionKey: "roles.manage",
      scope: null,
    }),
  ).rejects.toThrow(/locked/);
  await expect(
    asAdmin.mutation(api.rbac.setRolePermission, {
      roleId: agentRoleId,
      permissionKey: "not.a.permission",
      scope: "all_locations",
    }),
  ).rejects.toThrow(/Unknown permission/);
  await expect(
    t.withIdentity({ subject: chiefId }).mutation(api.rbac.setRolePermission, {
      roleId: agentRoleId,
      permissionKey: "users.manage",
      scope: "all_locations",
    }),
  ).rejects.toThrow(/roles\.manage/);
});

test("getRole returns null for a malformed or unknown id", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const asAdmin = t.withIdentity({ subject: adminId });
  expect(await asAdmin.query(api.rbac.getRole, { roleId: "not-an-id" })).toBeNull();
  const agentRoleId = await getRoleId(t, "sales_agent");
  const role = await asAdmin.query(api.rbac.getRole, { roleId: agentRoleId });
  expect(role?.role.key).toBe("sales_agent");
  expect(role?.locked).toBe(false);
});

test("listRoles returns every role with its permission count", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const roles = await t
    .withIdentity({ subject: adminId })
    .query(api.rbac.listRoles, {});
  expect(roles.map((r) => r.key)).toEqual([
    "super_admin",
    "chief_admin",
    "manager_admin",
    "chief_sales_admin",
    "chief_inventory_admin",
    "sales_agent",
  ]);
  expect(roles.find((r) => r.key === "super_admin")).toMatchObject({
    permissionCount: PERMISSIONS.length,
    locked: true,
  });
  expect(roles.find((r) => r.key === "sales_agent")?.permissionCount).toBe(
    Object.keys(SALES_AGENT_DEFAULTS).length,
  );
});

test("requirePermission returns the scope and enforces scopeCheck", async () => {
  const t = await setup();
  const agentId = await insertUserWithRole(t, "sales_agent", { email: "g@x.com" });
  const asAgent = t.withIdentity({ subject: agentId });

  const scope = await asAgent.run(async (ctx) => {
    const result = await requirePermission(ctx, "sales.create");
    return result.scope;
  });
  expect(scope).toBe("own_location");

  // A record at another location: own_location scope must not reach it.
  await expect(
    asAgent.run((ctx) =>
      requirePermission(
        ctx,
        "sales.create",
        (s) => s === "all_locations",
      ),
    ),
  ).rejects.toThrow(/outside your scope/);

  await expect(
    asAgent.run((ctx) => requirePermission(ctx, "sales.edit.approve")),
  ).rejects.toThrow(/sales\.edit\.approve/);
});

test("seed steps grant new keys to pre-existing roles exactly once", async () => {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  // Simulate a database seeded before the step existed: strip the step's
  // grants from Chief Sales Admin and forget the step was applied.
  const roleId = await getRoleId(t, "chief_sales_admin");
  await t.run(async (ctx) => {
    for (const key of PRODUCTS_AND_WITHDRAWALS) {
      const p = await ctx.db
        .query("permissions")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      const link = await ctx.db
        .query("rolePermissions")
        .withIndex("by_roleId_and_permissionId", (q) =>
          q.eq("roleId", roleId).eq("permissionId", p!._id),
        )
        .unique();
      await ctx.db.delete("rolePermissions", link!._id);
    }
    for (const step of await ctx.db.query("appliedSeedSteps").collect()) {
      await ctx.db.delete("appliedSeedSteps", step._id);
    }
  });

  await t.mutation(internal.rbac.seedRbac, {});
  const userId = await insertUserWithRole(t, "chief_sales_admin", {
    email: "cs@x.com",
  });
  const asUser = t.withIdentity({ subject: userId });
  let perms = await asUser.query(api.rbac.getMyPermissions, {});
  for (const key of PRODUCTS_AND_WITHDRAWALS) {
    expect(perms[key]).toBe("all_locations");
  }

  // A later revoke survives re-seeding: the step is recorded as applied.
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  await t.withIdentity({ subject: adminId }).mutation(api.rbac.setRolePermission, {
    roleId,
    permissionKey: "withdrawals.approve",
    scope: null,
  });
  await t.mutation(internal.rbac.seedRbac, {});
  perms = await asUser.query(api.rbac.getMyPermissions, {});
  expect(perms["withdrawals.approve"]).toBeUndefined();
});

test("listRoleOptions flags roles that require a location", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "a@x.com" });
  const options = await t
    .withIdentity({ subject: adminId })
    .query(api.rbac.listRoleOptions, {});
  expect(
    options.filter((o) => o.requiresLocation).map((o) => o.key),
  ).toEqual(["sales_agent"]);
});

test("a seed step can revoke: withdrawal approval is the Chief Admin's alone", async () => {
  const t = await setup();
  const perms = async (roleKey: string) => {
    const userId = await insertUserWithRole(t, roleKey, { email: `${roleKey}-${Math.random()}@x.com` });
    return await t.withIdentity({ subject: userId }).query(api.rbac.getMyPermissions, {});
  };
  // After the full seed (grant step, then the revoke step), only the
  // Chief Admin approves withdrawals among the non-locked roles.
  for (const role of ["manager_admin", "chief_sales_admin", "chief_inventory_admin", "sales_agent"]) {
    expect(await perms(role)).not.toHaveProperty("withdrawals.approve");
    expect(await perms(role)).toHaveProperty("payroll.create");
  }
  expect(await perms("chief_admin")).toMatchObject({ "withdrawals.approve": "all_locations" });

  // An admin re-grants it to a role: re-seeding doesn't revoke it again.
  const adminId = await insertUserWithRole(t, "super_admin", { email: "sa@x.com" });
  await t.withIdentity({ subject: adminId }).mutation(api.rbac.setRolePermission, {
    roleId: await getRoleId(t, "manager_admin"),
    permissionKey: "withdrawals.approve",
    scope: "all_locations",
  });
  await t.mutation(internal.rbac.seedRbac, {});
  expect(await perms("manager_admin")).toMatchObject({ "withdrawals.approve": "all_locations" });
});
