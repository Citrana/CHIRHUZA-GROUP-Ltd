import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./lib/permissions";
import { requirePermission } from "./lib/rbac";
import {
  getRoleId,
  insertUserWithRole,
  seedRbacForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  await seedRbacForTest(t);
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
  expect(perms).toEqual({ "sales.create": "own_location" });
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

test("getMyPermissions: Super Admin has everything, Sales Agent only its own-location pair, anonymous nothing", async () => {
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
  expect(agentPerms).toEqual({
    "sales.create": "own_location",
    "sales.edit.request": "own_location",
  });

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
  expect(logs.map((l) => l.action)).toEqual([
    "role.permission.granted",
    "role.permission.revoked",
  ]);
  expect(logs[0]).toMatchObject({
    actorId: adminId,
    entityType: "roles",
    entityId: agentRoleId,
    details: { permission: "users.manage", scope: "all_locations" },
  });
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
    action: "role.permission.scope_changed",
    details: { previousScope: "own_location", scope: "all_locations" },
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
  expect(roles.find((r) => r.key === "sales_agent")?.permissionCount).toBe(2);
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
