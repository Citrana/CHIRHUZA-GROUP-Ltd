import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  getRoleId,
  insertUserWithRole,
  seedRbacForTest,
} from "./lib/test-utils";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  await seedRbacForTest(t);
  return t;
}

test("getCurrentUser returns null when signed out", async () => {
  const t = await setup();
  const user = await t.query(api.users.getCurrentUser, {});
  expect(user).toBeNull();
});

test("getCurrentUser returns the active user's document", async () => {
  const t = await setup();
  const userId = await insertUserWithRole(t, "sales_agent", { email: "active@example.com" });
  const user = await t
    .withIdentity({ subject: userId })
    .query(api.users.getCurrentUser, {});
  expect(user?.email).toBe("active@example.com");
});

test("getCurrentUser returns null for a blocked user", async () => {
  const t = await setup();
  const userId = await insertUserWithRole(t, "sales_agent", { status: "blocked" });
  const user = await t
    .withIdentity({ subject: userId })
    .query(api.users.getCurrentUser, {});
  expect(user).toBeNull();
});

test("setUserStatus lets a Super Admin block and unblock a user, writing an audit log", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin@example.com" });
  const targetId = await insertUserWithRole(t, "sales_agent", { email: "target@example.com" });
  const asAdmin = t.withIdentity({ subject: adminId });

  await asAdmin.mutation(api.users.setUserStatus, {
    userId: targetId,
    status: "blocked",
  });
  let target = await t.run((ctx) => ctx.db.get("users", targetId));
  expect(target?.status).toBe("blocked");

  await asAdmin.mutation(api.users.setUserStatus, {
    userId: targetId,
    status: "active",
  });
  target = await t.run((ctx) => ctx.db.get("users", targetId));
  expect(target?.status).toBe("active");

  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs.map((l) => l.action)).toEqual(["user.blocked", "user.unblocked"]);
});

test("setUserStatus rejects a non-Super-Admin caller", async () => {
  const t = await setup();
  const regularId = await insertUserWithRole(t, "sales_agent", { email: "regular@example.com" });
  const targetId = await insertUserWithRole(t, "sales_agent", { email: "target2@example.com" });

  await expect(
    t
      .withIdentity({ subject: regularId })
      .mutation(api.users.setUserStatus, { userId: targetId, status: "blocked" }),
  ).rejects.toThrow();
});

test("setUserStatus rejects a Super Admin blocking themselves", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "self@example.com" });

  await expect(
    t
      .withIdentity({ subject: adminId })
      .mutation(api.users.setUserStatus, { userId: adminId, status: "blocked" }),
  ).rejects.toThrow();
});

test("createUser generates a one-time password that signs the new user in, forcing a password change", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin2@example.com" });

  const salesAgentRoleId = await getRoleId(t, "sales_agent");
  const { password } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "New Hire",
      email: "newhire@example.com",
      roleId: salesAgentRoleId,
    });
  expect(password).toHaveLength(16);

  const created = await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), "newhire@example.com"))
      .unique(),
  );
  expect(created?.mustChangePassword).toBe(true);
  expect(created?.roleId).toBe(salesAgentRoleId);
  expect(created?.createdBy).toBe(adminId);

  const result = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "newhire@example.com", password, flow: "signIn" },
  });
  expect(result.tokens).toBeTruthy();
});

test("createUser rejects a non-Super-Admin caller", async () => {
  const t = await setup();
  const regularId = await insertUserWithRole(t, "sales_agent", { email: "regular2@example.com" });

  await expect(
    t
      .withIdentity({ subject: regularId })
      .action(api.users.createUser, {
        name: "Nope",
        email: "nope@example.com",
        roleId: await getRoleId(t, "sales_agent"),
      }),
  ).rejects.toThrow();
});

test("a blocked user is rejected at sign-in", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin3@example.com" });
  const { password } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "Soon Blocked",
      roleId: await getRoleId(t, "sales_agent"),
      email: "blocked@example.com",
    });
  const targetId = (await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), "blocked@example.com"))
      .unique(),
  ))!._id;

  await t
    .withIdentity({ subject: adminId })
    .mutation(api.users.setUserStatus, { userId: targetId, status: "blocked" });

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "blocked@example.com", password, flow: "signIn" },
    }),
  ).rejects.toThrow();
});

test("changePassword updates the credential and clears mustChangePassword", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin4@example.com" });
  const { password: oldPassword } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "Will Rotate",
      roleId: await getRoleId(t, "sales_agent"),
      email: "rotate@example.com",
    });
  const userId = (await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), "rotate@example.com"))
      .unique(),
  ))!._id;

  await t
    .withIdentity({ subject: userId })
    .action(api.users.changePassword, { newPassword: "correct-horse-battery" });

  const updated = await t.run((ctx) => ctx.db.get("users", userId));
  expect(updated?.mustChangePassword).toBe(false);

  await expect(
    t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "rotate@example.com", password: oldPassword, flow: "signIn" },
    }),
  ).rejects.toThrow();

  const result = await t.action(api.auth.signIn, {
    provider: "password",
    params: {
      email: "rotate@example.com",
      password: "correct-horse-battery",
      flow: "signIn",
    },
  });
  expect(result.tokens).toBeTruthy();
});

test("setUserRole lets a Super Admin change a user's role, writing an audit log", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin5@example.com",
  });
  const targetId = await insertUserWithRole(t, "sales_agent", {
    email: "promote@example.com",
  });
  const chiefAdminRoleId = await getRoleId(t, "chief_admin");

  await t
    .withIdentity({ subject: adminId })
    .mutation(api.users.setUserRole, { userId: targetId, roleId: chiefAdminRoleId });

  const target = await t.run((ctx) => ctx.db.get("users", targetId));
  expect(target?.roleId).toBe(chiefAdminRoleId);
  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    action: "user.role_changed",
    targetUserId: targetId,
    details: { from: "sales_agent", to: "chief_admin" },
  });
});

test("setUserRole rejects a caller without roles.manage", async () => {
  const t = await setup();
  const callerId = await insertUserWithRole(t, "chief_admin", {
    email: "chief@example.com",
  });
  const targetId = await insertUserWithRole(t, "sales_agent", {
    email: "agent@example.com",
  });

  await expect(
    t.withIdentity({ subject: callerId }).mutation(api.users.setUserRole, {
      userId: targetId,
      roleId: await getRoleId(t, "super_admin"),
    }),
  ).rejects.toThrow(/roles\.manage/);
});

test("setUserRole rejects changing your own role", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin6@example.com",
  });

  await expect(
    t.withIdentity({ subject: adminId }).mutation(api.users.setUserRole, {
      userId: adminId,
      roleId: await getRoleId(t, "sales_agent"),
    }),
  ).rejects.toThrow(/own role/);
});

test("the last active Super Admin cannot be demoted or blocked", async () => {
  const t = await setup();
  const superAdminRoleId = await getRoleId(t, "super_admin");
  const lastAdminId = await insertUserWithRole(t, "super_admin", {
    email: "last@example.com",
  });
  // A non-Super-Admin who has been granted roles.manage + users.manage.
  const managerId = await insertUserWithRole(t, "manager_admin", {
    email: "mgr@example.com",
  });
  const managerRoleId = await getRoleId(t, "manager_admin");
  await t.run(async (ctx) => {
    for (const key of ["roles.manage", "users.manage"]) {
      const p = await ctx.db
        .query("permissions")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      await ctx.db.insert("rolePermissions", {
        roleId: managerRoleId,
        permissionId: p!._id,
        scope: "all_locations",
      });
    }
  });
  const asManager = t.withIdentity({ subject: managerId });

  await expect(
    asManager.mutation(api.users.setUserRole, {
      userId: lastAdminId,
      roleId: managerRoleId,
    }),
  ).rejects.toThrow(/last active Super Admin/);
  await expect(
    asManager.mutation(api.users.setUserStatus, {
      userId: lastAdminId,
      status: "blocked",
    }),
  ).rejects.toThrow(/last active Super Admin/);

  // With a second Super Admin present, demotion is allowed.
  await insertUserWithRole(t, "super_admin", { email: "second@example.com" });
  await asManager.mutation(api.users.setUserRole, {
    userId: lastAdminId,
    roleId: managerRoleId,
  });
  const demoted = await t.run((ctx) => ctx.db.get("users", lastAdminId));
  expect(demoted?.roleId).not.toBe(superAdminRoleId);
});

test("createUser requires roles.manage to mint a Super Admin", async () => {
  const t = await setup();
  const managerId = await insertUserWithRole(t, "manager_admin", {
    email: "mgr2@example.com",
  });
  const managerRoleId = await getRoleId(t, "manager_admin");
  await t.run(async (ctx) => {
    const p = await ctx.db
      .query("permissions")
      .withIndex("by_key", (q) => q.eq("key", "users.manage"))
      .unique();
    await ctx.db.insert("rolePermissions", {
      roleId: managerRoleId,
      permissionId: p!._id,
      scope: "all_locations",
    });
  });

  await expect(
    t.withIdentity({ subject: managerId }).action(api.users.createUser, {
      name: "Sneaky",
      email: "sneaky@example.com",
      roleId: await getRoleId(t, "super_admin"),
    }),
  ).rejects.toThrow(/roles\.manage/);
});
