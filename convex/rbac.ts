import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getCurrentUserOrNull } from "./lib/auth";
import {
  authedMutation,
  authedQuery,
  loadIsSuperAdmin,
  loadPermissions,
  roleRequiresLocation,
} from "./lib/rbac";
import {
  PERMISSIONS,
  SEED_STEPS,
  SUPER_ADMIN_ROLE_KEY,
  SYSTEM_ROLES,
  isPermissionKey,
  scopeValidator,
  type Scope,
} from "./lib/permissions";

async function ensureRolePermission(
  ctx: MutationCtx,
  roleId: Id<"roles">,
  permissionId: Id<"permissions">,
  scope: Scope,
) {
  const link = await ctx.db
    .query("rolePermissions")
    .withIndex("by_roleId_and_permissionId", (q) =>
      q.eq("roleId", roleId).eq("permissionId", permissionId),
    )
    .unique();
  if (!link) {
    await ctx.db.insert("rolePermissions", { roleId, permissionId, scope });
  } else if (link.scope !== scope) {
    await ctx.db.patch("rolePermissions", link._id, { scope });
  }
}

/**
 * Idempotently seeds the permission catalog and the six system roles from
 * convex/lib/permissions.ts. Safe to re-run at any time:
 *   npx convex run rbac:seedRbac
 * - Permissions are upserted by key.
 * - A missing system role is created with its default permissions. An
 *   existing role's permissions are left alone (Super Admin edits survive),
 *   except Super Admin, which is locked and always re-synced to everything.
 * - SEED_STEPS not yet recorded in `appliedSeedSteps` are applied once
 *   (grants that must also reach roles that already existed, and revokes).
 * - Pre-RBAC users flagged `isSuperAdmin` are moved onto the Super Admin role.
 * System bootstrap with no acting user, so it writes no audit entries.
 */
export const seedRbac = internalMutation({
  args: {},
  returns: v.object({ superAdminRoleId: v.id("roles") }),
  handler: async (ctx) => {
    const permissionIds = new Map<string, Id<"permissions">>();
    for (const p of PERMISSIONS) {
      const existing = await ctx.db
        .query("permissions")
        .withIndex("by_key", (q) => q.eq("key", p.key))
        .unique();
      if (existing) {
        if (
          existing.description !== p.description ||
          existing.module !== p.module
        ) {
          await ctx.db.patch("permissions", existing._id, {
            description: p.description,
            module: p.module,
          });
        }
        permissionIds.set(p.key, existing._id);
      } else {
        permissionIds.set(p.key, await ctx.db.insert("permissions", { ...p }));
      }
    }

    let superAdminRoleId: Id<"roles"> | null = null;
    const roleIds = new Map<string, Id<"roles">>();
    for (const seed of SYSTEM_ROLES) {
      const existing = await ctx.db
        .query("roles")
        .withIndex("by_key", (q) => q.eq("key", seed.key))
        .unique();
      const roleId =
        existing?._id ??
        (await ctx.db.insert("roles", {
          key: seed.key,
          name: seed.name,
          description: seed.description,
          isSystem: true,
        }));
      if (!existing || seed.key === SUPER_ADMIN_ROLE_KEY) {
        for (const [key, scope] of seed.permissions) {
          await ensureRolePermission(ctx, roleId, permissionIds.get(key)!, scope);
        }
      }
      roleIds.set(seed.key, roleId);
      if (seed.key === SUPER_ADMIN_ROLE_KEY) {
        superAdminRoleId = roleId;
      }
    }

    for (const step of SEED_STEPS) {
      const applied = await ctx.db
        .query("appliedSeedSteps")
        .withIndex("by_key", (q) => q.eq("key", step.key))
        .unique();
      if (applied) {
        continue;
      }
      for (const [roleKey, permissionKey, scope] of step.grants) {
        const roleId = roleIds.get(roleKey);
        if (roleId) {
          await ensureRolePermission(
            ctx,
            roleId,
            permissionIds.get(permissionKey)!,
            scope,
          );
        }
      }
      for (const [roleKey, permissionKey] of step.revokes ?? []) {
        const roleId = roleIds.get(roleKey);
        const permissionId = permissionIds.get(permissionKey)!;
        const link = roleId
          ? await ctx.db
              .query("rolePermissions")
              .withIndex("by_roleId_and_permissionId", (q) =>
                q.eq("roleId", roleId).eq("permissionId", permissionId),
              )
              .unique()
          : null;
        if (link) await ctx.db.delete("rolePermissions", link._id);
      }
      await ctx.db.insert("appliedSeedSteps", { key: step.key });
    }

    const legacyAdmins = await ctx.db
      .query("users")
      .withIndex("by_roleId", (q) => q.eq("roleId", null))
      .filter((q) => q.eq(q.field("isSuperAdmin"), true))
      .take(100);
    for (const user of legacyAdmins) {
      await ctx.db.patch("users", user._id, { roleId: superAdminRoleId! });
    }

    return { superAdminRoleId: superAdminRoleId! };
  },
});

/** Used by authedAction, which has no ctx.db. */
export const getPermissionsForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  returns: v.object({
    permissions: v.array(v.object({ key: v.string(), scope: scopeValidator })),
    isSuperAdmin: v.boolean(),
  }),
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get("users", userId);
    if (!user) {
      return { permissions: [], isSuperAdmin: false };
    }
    const permissions = await loadPermissions(ctx, user);
    return {
      permissions: [...permissions].map(([key, scope]) => ({ key, scope })),
      isSuperAdmin: await loadIsSuperAdmin(ctx, user),
    };
  },
});

export const roleRequiresLocationInternal = internalQuery({
  args: { roleId: v.id("roles") },
  returns: v.boolean(),
  handler: async (ctx, { roleId }) => {
    return await roleRequiresLocation(ctx, roleId);
  },
});

export const getRoleByIdInternal = internalQuery({
  args: { roleId: v.id("roles") },
  handler: async (ctx, { roleId }) => {
    return await ctx.db.get("roles", roleId);
  },
});

/**
 * The caller's effective permissions as `{ [key]: scope }`, for the
 * frontend's useCan(). Empty when signed out - it never throws, so the UI
 * can call it unconditionally. UI hiding only; the server stays the
 * authority via requirePermission.
 */
export const getMyPermissions = query({
  args: {},
  returns: v.record(v.string(), scopeValidator),
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) {
      return {};
    }
    return Object.fromEntries(await loadPermissions(ctx, user));
  },
});

export const listRoles = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("roles.manage");
    const roles = await ctx.db.query("roles").take(100);
    return await Promise.all(
      roles.map(async (role) => {
        const links = await ctx.db
          .query("rolePermissions")
          .withIndex("by_roleId_and_permissionId", (q) =>
            q.eq("roleId", role._id),
          )
          .collect();
        return {
          ...role,
          permissionCount: links.length,
          locked: role.key === SUPER_ADMIN_ROLE_KEY,
        };
      }),
    );
  },
});

/** Role picker options for creating users / assigning roles. */
export const listRoleOptions = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("users.manage");
    const roles = await ctx.db.query("roles").take(100);
    return await Promise.all(
      roles.map(async (r) => ({
        _id: r._id,
        key: r.key,
        name: r.name,
        requiresLocation: await roleRequiresLocation(ctx, r._id),
      })),
    );
  },
});

/**
 * A role plus every catalog permission, grouped by module, with its grant.
 * Takes the id as a plain string (it comes from the URL) and returns null
 * for a malformed or unknown id instead of failing validation.
 */
export const getRole = authedQuery({
  args: { roleId: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("roles.manage");
    const roleId = ctx.db.normalizeId("roles", args.roleId);
    const role = roleId ? await ctx.db.get("roles", roleId) : null;
    if (!roleId || !role) {
      return null;
    }
    const links = await ctx.db
      .query("rolePermissions")
      .withIndex("by_roleId_and_permissionId", (q) => q.eq("roleId", roleId))
      .collect();
    const granted = new Map<string, Scope>();
    for (const link of links) {
      const permission = await ctx.db.get("permissions", link.permissionId);
      if (permission) {
        granted.set(permission.key, link.scope);
      }
    }

    const modules: Array<{
      module: string;
      permissions: Array<{ key: string; description: string; scope: Scope | null }>;
    }> = [];
    for (const p of PERMISSIONS) {
      let group = modules.find((m) => m.module === p.module);
      if (!group) {
        group = { module: p.module, permissions: [] };
        modules.push(group);
      }
      group.permissions.push({
        key: p.key,
        description: p.description,
        scope: granted.get(p.key) ?? null,
      });
    }

    return { role, locked: role.key === SUPER_ADMIN_ROLE_KEY, modules };
  },
});

/**
 * Grants a permission to a role, changes its scope, or revokes it
 * (`scope: null`). Applies immediately: permissions are resolved fresh on
 * every call. Role config is system configuration, not business data, so a
 * revoke is direct (no approval request) - but always audited.
 */
export const setRolePermission = authedMutation({
  args: {
    roleId: v.id("roles"),
    permissionKey: v.string(),
    scope: v.union(scopeValidator, v.null()),
  },
  handler: async (ctx, { roleId, permissionKey, scope }) => {
    await ctx.requirePermission("roles.manage");
    if (!isPermissionKey(permissionKey)) {
      throw new ConvexError("Unknown permission.");
    }
    const role = await ctx.db.get("roles", roleId);
    if (!role) {
      throw new ConvexError("Role not found.");
    }
    if (role.key === SUPER_ADMIN_ROLE_KEY) {
      throw new ConvexError("The Super Admin role is locked.");
    }
    const permission = await ctx.db
      .query("permissions")
      .withIndex("by_key", (q) => q.eq("key", permissionKey))
      .unique();
    if (!permission) {
      throw new ConvexError("Permission not seeded. Run rbac:seedRbac.");
    }
    const link = await ctx.db
      .query("rolePermissions")
      .withIndex("by_roleId_and_permissionId", (q) =>
        q.eq("roleId", roleId).eq("permissionId", permission._id),
      )
      .unique();

    // Readable keys alongside ids, so the audit page makes sense on its own.
    const describe = (linkScope: Scope) => ({
      roleId,
      role: role.key,
      permission: permissionKey,
      scope: linkScope,
    });

    if (scope === null) {
      if (link) {
        await ctx.db.delete("rolePermissions", link._id);
        await ctx.audit({
          action: "delete",
          entityTable: "rolePermissions",
          entityId: link._id,
          before: describe(link.scope),
        });
      }
    } else if (!link) {
      const linkId = await ctx.db.insert("rolePermissions", {
        roleId,
        permissionId: permission._id,
        scope,
      });
      await ctx.audit({
        action: "create",
        entityTable: "rolePermissions",
        entityId: linkId,
        after: describe(scope),
      });
    } else if (link.scope !== scope) {
      await ctx.db.patch("rolePermissions", link._id, { scope });
      await ctx.audit({
        action: "update",
        entityTable: "rolePermissions",
        entityId: link._id,
        before: describe(link.scope),
        after: describe(scope),
      });
    }
  },
});
