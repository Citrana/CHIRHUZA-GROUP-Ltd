import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

async function insertUser(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    name: string;
    email: string;
    status: "active" | "blocked";
    mustChangePassword: boolean;
    isSuperAdmin: boolean;
    createdBy: Id<"users"> | null;
  }> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: overrides.name ?? "Test User",
      email: overrides.email ?? "user@example.com",
      roleId: null,
      status: overrides.status ?? "active",
      mustChangePassword: overrides.mustChangePassword ?? false,
      isSuperAdmin: overrides.isSuperAdmin ?? false,
      createdBy: overrides.createdBy ?? null,
    });
  });
}

test("getCurrentUser returns null when signed out", async () => {
  const t = convexTest(schema, modules);
  const user = await t.query(api.users.getCurrentUser, {});
  expect(user).toBeNull();
});

test("getCurrentUser returns the active user's document", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, { email: "active@example.com" });
  const user = await t
    .withIdentity({ subject: userId })
    .query(api.users.getCurrentUser, {});
  expect(user?.email).toBe("active@example.com");
});

test("getCurrentUser returns null for a blocked user", async () => {
  const t = convexTest(schema, modules);
  const userId = await insertUser(t, { status: "blocked" });
  const user = await t
    .withIdentity({ subject: userId })
    .query(api.users.getCurrentUser, {});
  expect(user).toBeNull();
});

test("setUserStatus lets a Super Admin block and unblock a user, writing an audit log", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, {
    email: "admin@example.com",
    isSuperAdmin: true,
  });
  const targetId = await insertUser(t, { email: "target@example.com" });
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
  const t = convexTest(schema, modules);
  const regularId = await insertUser(t, { email: "regular@example.com" });
  const targetId = await insertUser(t, { email: "target2@example.com" });

  await expect(
    t
      .withIdentity({ subject: regularId })
      .mutation(api.users.setUserStatus, { userId: targetId, status: "blocked" }),
  ).rejects.toThrow();
});

test("setUserStatus rejects a Super Admin blocking themselves", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, {
    email: "self@example.com",
    isSuperAdmin: true,
  });

  await expect(
    t
      .withIdentity({ subject: adminId })
      .mutation(api.users.setUserStatus, { userId: adminId, status: "blocked" }),
  ).rejects.toThrow();
});

test("createUser generates a one-time password that signs the new user in, forcing a password change", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, {
    email: "admin2@example.com",
    isSuperAdmin: true,
  });

  const { password } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "New Hire",
      email: "newhire@example.com",
    });
  expect(password).toHaveLength(16);

  const created = await t.run((ctx) =>
    ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), "newhire@example.com"))
      .unique(),
  );
  expect(created?.mustChangePassword).toBe(true);
  expect(created?.isSuperAdmin).toBe(false);
  expect(created?.createdBy).toBe(adminId);

  const result = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "newhire@example.com", password, flow: "signIn" },
  });
  expect(result.tokens).toBeTruthy();
});

test("createUser rejects a non-Super-Admin caller", async () => {
  const t = convexTest(schema, modules);
  const regularId = await insertUser(t, { email: "regular2@example.com" });

  await expect(
    t
      .withIdentity({ subject: regularId })
      .action(api.users.createUser, { name: "Nope", email: "nope@example.com" }),
  ).rejects.toThrow();
});

test("a blocked user is rejected at sign-in", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, {
    email: "admin3@example.com",
    isSuperAdmin: true,
  });
  const { password } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "Soon Blocked",
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
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, {
    email: "admin4@example.com",
    isSuperAdmin: true,
  });
  const { password: oldPassword } = await t
    .withIdentity({ subject: adminId })
    .action(api.users.createUser, {
      name: "Will Rotate",
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
