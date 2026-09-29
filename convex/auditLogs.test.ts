import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as auditLogsModule from "./auditLogs";
import { appendOnlyGuardedDb } from "./lib/rbac";
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
  const adminId = await insertUserWithRole(t, "super_admin", {
    name: "Admin",
    email: "admin@x.com",
  });
  return { t, adminId, asAdmin: t.withIdentity({ subject: adminId }) };
}

const PAGE = { numItems: 50, cursor: null };

test("creating a user, changing their role and editing permissions all show up in the log", async () => {
  const { t, adminId, asAdmin } = await setup();
  const locationId = await insertLocation(t, { name: "Kenya Shop" });
  const hairId = await t.run(async (ctx) => {
    const location = await ctx.db.get("locations", locationId);
    return location!.businessUnitId;
  });

  const { password } = await asAdmin.action(api.users.createUser, {
    name: "New Agent",
    email: "agent@x.com",
    roleId: await getRoleId(t, "sales_agent"),
    locationId,
  });
  const newUser = await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", "agent@x.com"))
      .unique(),
  );
  await asAdmin.mutation(api.users.setUserRole, {
    userId: newUser!._id,
    roleId: await getRoleId(t, "chief_sales_admin"),
  });
  await asAdmin.mutation(api.rbac.setRolePermission, {
    roleId: await getRoleId(t, "chief_sales_admin"),
    permissionKey: "analytics.view",
    scope: "all_locations",
  });

  const { page } = await asAdmin.query(api.auditLogs.list, {
    paginationOpts: PAGE,
  });
  // Newest first.
  expect(page.map((e) => [e.action, e.entityTable])).toEqual([
    ["create", "rolePermissions"],
    ["update", "users"],
    ["create", "users"],
  ]);
  const created = page[2];
  expect(created).toMatchObject({
    actorId: adminId,
    actorName: "Admin",
    actorEmail: "admin@x.com",
    entityId: newUser!._id,
    businessUnitId: hairId,
    after: {
      name: "New Agent",
      email: "agent@x.com",
      role: "sales_agent",
      location: "Kenya Shop",
      status: "active",
    },
  });
  // The generated password is never logged.
  expect(JSON.stringify(page)).not.toContain(password);
  expect(page[1]).toMatchObject({
    before: { role: "sales_agent" },
    after: { role: "chief_sales_admin" },
  });
  expect(page[0].after).toMatchObject({
    role: "chief_sales_admin",
    permission: "analytics.view",
  });
  for (const entry of page) {
    expect(entry.timestamp).toBeTypeOf("number");
  }
});

test("changing a password logs the change but never the password", async () => {
  const { t, asAdmin } = await setup();
  await asAdmin.action(api.users.createUser, {
    name: "Rotator",
    email: "rotate@x.com",
    roleId: await getRoleId(t, "chief_admin"),
  });
  const userId = (await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", "rotate@x.com"))
      .unique(),
  ))!._id;

  await t
    .withIdentity({ subject: userId })
    .action(api.users.changePassword, { newPassword: "a-secret-phrase" });

  const logs = await t.run((ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_actorId_and_timestamp", (q) => q.eq("actorId", userId))
      .collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    action: "update",
    entityTable: "users",
    entityId: userId,
    before: { mustChangePassword: true },
    after: { mustChangePassword: false, passwordChanged: true },
  });
  expect(JSON.stringify(logs[0])).not.toContain("a-secret-phrase");
});

async function insertEntry(
  t: Awaited<ReturnType<typeof setup>>["t"],
  entry: {
    actorId: Id<"users">;
    action: "create" | "update" | "delete" | "approve" | "reject";
    entityTable: string;
    entityId: string;
    timestamp: number;
  },
) {
  await t.run((ctx) => ctx.db.insert("auditLogs", entry));
}

test("list filters by actor, action, entity and date range", async () => {
  const { t, adminId, asAdmin } = await setup();
  const otherId = await insertUserWithRole(t, "chief_admin", { email: "o@x.com" });
  const day = Date.UTC(2026, 8, 10); // 2026-09-10T00:00Z
  await insertEntry(t, { actorId: adminId, action: "create", entityTable: "users", entityId: "u1", timestamp: day });
  await insertEntry(t, { actorId: adminId, action: "update", entityTable: "users", entityId: "u1", timestamp: day + 1000 });
  await insertEntry(t, { actorId: otherId, action: "update", entityTable: "locations", entityId: "l1", timestamp: day + 2000 });
  await insertEntry(t, { actorId: otherId, action: "delete", entityTable: "rolePermissions", entityId: "r1", timestamp: day + 86_400_000 });

  const ids = async (filters: Record<string, unknown>) =>
    (
      await asAdmin.query(api.auditLogs.list, { paginationOpts: PAGE, ...filters })
    ).page.map((e) => `${e.action}:${e.entityId}`);

  expect(await ids({})).toEqual(["delete:r1", "update:l1", "update:u1", "create:u1"]);
  expect(await ids({ actorId: otherId })).toEqual(["delete:r1", "update:l1"]);
  expect(await ids({ action: "update" })).toEqual(["update:l1", "update:u1"]);
  expect(await ids({ entityTable: "users" })).toEqual(["update:u1", "create:u1"]);
  expect(await ids({ entityTable: "users", entityId: "u1", action: "create" })).toEqual(["create:u1"]);
  expect(await ids({ actorId: adminId, action: "update" })).toEqual(["update:u1"]);
  expect(await ids({ from: day + 500, to: day + 5000 })).toEqual(["update:l1", "update:u1"]);
  expect(await ids({ actorId: otherId, from: day + 10_000 })).toEqual(["delete:r1"]);
});

test("list paginates newest first", async () => {
  const { t, adminId, asAdmin } = await setup();
  for (let i = 0; i < 5; i++) {
    await insertEntry(t, { actorId: adminId, action: "update", entityTable: "users", entityId: `u${i}`, timestamp: 1000 + i });
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: { entityId: string }[]; isDone: boolean; continueCursor: string } =
      await asAdmin.query(api.auditLogs.list, { paginationOpts: { numItems: 2, cursor } });
    seen.push(...result.page.map((e) => e.entityId));
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(seen).toEqual(["u4", "u3", "u2", "u1", "u0"]);
});

test("reading the log requires audit.view; Chief Admin has it, Sales Agent doesn't", async () => {
  const { t } = await setup();
  const agentId = await insertUserWithRole(t, "sales_agent", {
    email: "g@x.com",
    locationId: await insertLocation(t),
  });
  const chiefId = await insertUserWithRole(t, "chief_admin", { email: "c@x.com" });

  const asAgent = t.withIdentity({ subject: agentId });
  await expect(
    asAgent.query(api.auditLogs.list, { paginationOpts: PAGE }),
  ).rejects.toThrow(/audit\.view/);
  await expect(asAgent.query(api.auditLogs.listActors, {})).rejects.toThrow(
    /audit\.view/,
  );

  const asChief = t.withIdentity({ subject: chiefId });
  await asChief.query(api.auditLogs.list, { paginationOpts: PAGE });
  const actors = await asChief.query(api.auditLogs.listActors, {});
  expect(actors.map((a) => a.email)).toContain("g@x.com");
});

test("the auditLogs module exposes no public mutation or action", () => {
  for (const [name, fn] of Object.entries(auditLogsModule)) {
    const registered = fn as { isQuery?: boolean; isInternal?: boolean };
    if (!registered.isQuery) {
      expect(registered.isInternal, `${name} must be internal`).toBe(true);
    }
  }
});

test("the guarded ctx.db of authedMutation refuses to modify audit rows", async () => {
  const { t, adminId } = await setup();
  const entryId = await t.run((ctx) =>
    ctx.db.insert("auditLogs", {
      actorId: adminId,
      action: "create",
      entityTable: "users",
      entityId: "u1",
      timestamp: 1,
    }),
  );

  await expect(
    t.run((ctx) =>
      appendOnlyGuardedDb(ctx).patch("auditLogs", entryId, { reason: "tamper" }),
    ),
  ).rejects.toThrow();
  await expect(
    t.run((ctx) => appendOnlyGuardedDb(ctx).delete("auditLogs", entryId)),
  ).rejects.toThrow();
  // Inserting is still allowed.
  await t.run((ctx) =>
    appendOnlyGuardedDb(ctx).insert("auditLogs", {
      actorId: adminId,
      action: "create",
      entityTable: "users",
      entityId: "u2",
      timestamp: 2,
    }),
  );
  const rows = await t.run((ctx) => ctx.db.query("auditLogs").collect());
  expect(rows.map((r) => r.reason)).toEqual([undefined, undefined]);
});

test("no Convex source file patches, replaces or deletes audit rows", () => {
  const sources = import.meta.glob("./**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const offenders = Object.entries(sources)
    .filter(([path]) => !path.includes("_generated") && !path.endsWith(".test.ts"))
    .filter(([, source]) =>
      /\.(patch|replace|delete)\(\s*["'`]auditLogs["'`]/.test(source),
    )
    .map(([path]) => path);
  expect(Object.keys(sources).length).toBeGreaterThan(5);
  expect(offenders).toEqual([]);
});
