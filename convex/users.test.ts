import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  getRoleId,
  insertLocation,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
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
  expect(
    logs.map((l) => [l.action, l.entityTable, l.before?.status, l.after?.status]),
  ).toEqual([
    ["update", "users", "active", "blocked"],
    ["update", "users", "blocked", "active"],
  ]);
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
      locationId: await insertLocation(t),
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
      locationId: await insertLocation(t),
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
      locationId: await insertLocation(t),
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
    actorId: adminId,
    action: "update",
    entityTable: "users",
    entityId: targetId,
    before: { role: "sales_agent" },
    after: { roleId: chiefAdminRoleId, role: "chief_admin" },
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

test("createUser requires an active location for a role with own_location permissions", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin7@example.com",
  });
  const asAdmin = t.withIdentity({ subject: adminId });
  const salesAgentRoleId = await getRoleId(t, "sales_agent");

  await expect(
    asAdmin.action(api.users.createUser, {
      name: "No Location",
      email: "noloc@example.com",
      roleId: salesAgentRoleId,
    }),
  ).rejects.toThrow(/requires a location/);

  await expect(
    asAdmin.action(api.users.createUser, {
      name: "Closed Shop",
      email: "closed@example.com",
      roleId: salesAgentRoleId,
      locationId: await insertLocation(t, { active: false }),
    }),
  ).rejects.toThrow(/inactive/);

  // Roles without own_location permissions don't need one.
  await asAdmin.action(api.users.createUser, {
    name: "Chief",
    email: "chief2@example.com",
    roleId: await getRoleId(t, "chief_admin"),
  });
});

test("setUserRole rejects moving a user without a location onto Sales Agent", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin8@example.com",
  });
  const targetId = await insertUserWithRole(t, "chief_admin", {
    email: "noloc2@example.com",
  });

  await expect(
    t.withIdentity({ subject: adminId }).mutation(api.users.setUserRole, {
      userId: targetId,
      roleId: await getRoleId(t, "sales_agent"),
    }),
  ).rejects.toThrow(/requires a location/);
});

test("setUserLocation sets a location with an audit entry, and can't clear a required one", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin9@example.com",
  });
  const asAdmin = t.withIdentity({ subject: adminId });
  const firstShop = await insertLocation(t, { name: "First" });
  const secondShop = await insertLocation(t, { name: "Second" });
  const agentId = await insertUserWithRole(t, "sales_agent", {
    email: "agent2@example.com",
    locationId: firstShop,
  });

  await asAdmin.mutation(api.users.setUserLocation, {
    userId: agentId,
    locationId: secondShop,
  });
  const agent = await t.run((ctx) => ctx.db.get("users", agentId));
  expect(agent?.locationId).toBe(secondShop);
  const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(logs[0]).toMatchObject({
    action: "update",
    entityTable: "users",
    entityId: agentId,
    before: { locationId: firstShop, location: "First" },
    after: { locationId: secondShop, location: "Second" },
  });

  await expect(
    asAdmin.mutation(api.users.setUserLocation, {
      userId: agentId,
      locationId: null,
    }),
  ).rejects.toThrow(/requires a location/);

  await expect(
    asAdmin.mutation(api.users.setUserLocation, {
      userId: agentId,
      locationId: await insertLocation(t, { active: false }),
    }),
  ).rejects.toThrow(/inactive/);

  // A role without own_location permissions may have its location cleared.
  const chiefId = await insertUserWithRole(t, "chief_admin", {
    email: "chief3@example.com",
    locationId: firstShop,
  });
  await asAdmin.mutation(api.users.setUserLocation, {
    userId: chiefId,
    locationId: null,
  });
  const chief = await t.run((ctx) => ctx.db.get("users", chiefId));
  expect(chief?.locationId).toBeUndefined();
});

test("setUserLocation rejects a caller without users.manage", async () => {
  const t = await setup();
  const agentId = await insertUserWithRole(t, "sales_agent", {
    email: "agent3@example.com",
    locationId: await insertLocation(t),
  });

  await expect(
    t.withIdentity({ subject: agentId }).mutation(api.users.setUserLocation, {
      userId: agentId,
      locationId: await insertLocation(t, { name: "Elsewhere" }),
    }),
  ).rejects.toThrow(/users\.manage/);
});

test("listUsers includes each user's location name", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", {
    email: "admin10@example.com",
  });
  await insertUserWithRole(t, "sales_agent", {
    email: "agent4@example.com",
    locationId: await insertLocation(t, { name: "Kenya Shop" }),
  });
  const users = await t
    .withIdentity({ subject: adminId })
    .query(api.users.listUsers, {});
  expect(users.find((u) => u.email === "agent4@example.com")?.locationName).toBe(
    "Kenya Shop",
  );
});

/** A user created through createUser (so they have a real password account). */
async function createdUser(t: Awaited<ReturnType<typeof setup>>, adminId: Awaited<ReturnType<typeof insertUserWithRole>>, email: string) {
  const { password } = await t.withIdentity({ subject: adminId }).action(api.users.createUser, {
    name: "Forgetful",
    email,
    roleId: await getRoleId(t, "sales_agent"),
    locationId: await insertLocation(t),
  });
  const user = await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), email))
      .unique(),
  );
  return { userId: user!._id, password };
}

const signIn = (t: Awaited<ReturnType<typeof setup>>, email: string, password: string) =>
  t.action(api.auth.signIn, { provider: "password", params: { email, password, flow: "signIn" } });

test("resetPassword: a new one-time password, old one refused, sessions ended, forced change, audited without the password", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin-reset@example.com" });
  const { userId, password: oldPassword } = await createdUser(t, adminId, "forgot@example.com");

  // The user had chosen their own password and has an open session.
  await t.withIdentity({ subject: userId }).action(api.users.changePassword, { newPassword: "my-own-password" });
  expect((await signIn(t, "forgot@example.com", "my-own-password")).tokens).toBeTruthy();
  const sessionsBefore = await t.run((ctx) =>
    ctx.db.query("authSessions").filter((q) => q.eq(q.field("userId"), userId)).collect(),
  );
  expect(sessionsBefore.length).toBeGreaterThan(0);

  const { password } = await t.withIdentity({ subject: adminId }).action(api.users.resetPassword, { userId });
  expect(password).toHaveLength(16);
  expect(password).not.toBe(oldPassword);

  // Every session of that user is gone; the old password no longer works.
  const sessionsAfter = await t.run((ctx) =>
    ctx.db.query("authSessions").filter((q) => q.eq(q.field("userId"), userId)).collect(),
  );
  expect(sessionsAfter).toEqual([]);
  await expect(signIn(t, "forgot@example.com", "my-own-password")).rejects.toThrow();
  expect((await signIn(t, "forgot@example.com", password)).tokens).toBeTruthy();
  expect((await t.run((ctx) => ctx.db.get("users", userId)))!.mustChangePassword).toBe(true);

  // Audited by the admin, and the password appears nowhere in the log.
  const entries = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  const reset = entries.find((e) => e.entityId === userId && (e.after as { passwordReset?: boolean } | undefined)?.passwordReset);
  expect(reset).toMatchObject({ actorId: adminId, action: "update", entityTable: "users", after: { mustChangePassword: true } });
  expect(JSON.stringify(entries)).not.toContain(password);

  // The user then chooses their own password, which clears the flag.
  await t.withIdentity({ subject: userId }).action(api.users.changePassword, { newPassword: "brand-new-password" });
  expect((await t.run((ctx) => ctx.db.get("users", userId)))!.mustChangePassword).toBe(false);
});

test("resetPassword is refused without users.manage, on your own account, and on a Super Admin without roles.manage", async () => {
  const t = await setup();
  const adminId = await insertUserWithRole(t, "super_admin", { email: "admin-r2@example.com" });
  const { userId } = await createdUser(t, adminId, "victim@example.com");

  const chiefId = await insertUserWithRole(t, "chief_admin", { email: "chief-r2@example.com" });
  await expect(t.withIdentity({ subject: chiefId }).action(api.users.resetPassword, { userId })).rejects.toThrow(/users\.manage/);
  await expect(t.withIdentity({ subject: adminId }).action(api.users.resetPassword, { userId: adminId })).rejects.toThrow(
    /your own account/,
  );

  // A role with users.manage but not roles.manage can't reset a Super Admin.
  const otherAdminId = await insertUserWithRole(t, "super_admin", { email: "admin-r3@example.com" });
  await t.run(async (ctx) => {
    const roleId = await ctx.db.insert("roles", { key: "user_manager", name: "User manager", description: "", isSystem: false });
    const permission = (await ctx.db.query("permissions").collect()).find((p) => p.key === "users.manage")!;
    await ctx.db.insert("rolePermissions", { roleId, permissionId: permission._id, scope: "all_locations" });
    await ctx.db.patch("users", chiefId, { roleId });
  });
  await expect(t.withIdentity({ subject: chiefId }).action(api.users.resetPassword, { userId: otherAdminId })).rejects.toThrow(
    /roles\.manage/,
  );
  // ...but can reset an ordinary user.
  await expect(t.withIdentity({ subject: chiefId }).action(api.users.resetPassword, { userId })).resolves.toHaveProperty("password");
});
