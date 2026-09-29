import { ConvexError } from "convex/values";
import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import {
  wrapDatabaseWriter,
  type Rules,
} from "convex-helpers/server/rowLevelSecurity";
import { action, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireCurrentUser, requireCurrentUserFromAction } from "./auth";
import { logAudit, type AuditEntry } from "./audit";
import {
  isPermissionKey,
  SUPER_ADMIN_ROLE_KEY,
  type PermissionKey,
  type Scope,
} from "./permissions";

export type PermissionMap = ReadonlyMap<PermissionKey, Scope>;

/**
 * Optional extra check run after the permission itself is confirmed, e.g.
 * `(scope) => scope === "all_locations" || record.locationId === myLocation`.
 * Returning false rejects the call.
 */
export type ScopeCheck = (
  scope: Scope,
  user: Doc<"users">,
) => boolean | Promise<boolean>;

/**
 * Resolves User -> Role -> Permissions. Always read fresh from the database
 * (never cached), so a role change takes effect on the very next call - and
 * queries using it re-run reactively when the role's permissions change.
 */
export async function loadPermissions(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<PermissionMap> {
  const permissions = new Map<PermissionKey, Scope>();
  if (user.roleId === null) {
    return permissions;
  }
  const links = await ctx.db
    .query("rolePermissions")
    .withIndex("by_roleId_and_permissionId", (q) =>
      q.eq("roleId", user.roleId!),
    )
    .collect();
  const docs = await Promise.all(
    links.map((link) => ctx.db.get("permissions", link.permissionId)),
  );
  links.forEach((link, i) => {
    const key = docs[i]?.key;
    if (key !== undefined && isPermissionKey(key)) {
      permissions.set(key, link.scope);
    }
  });
  return permissions;
}

/**
 * A role "requires a location" when any of its permissions is scoped to
 * own_location - such a scope is meaningless for a user with no location.
 */
export async function roleRequiresLocation(
  ctx: QueryCtx | MutationCtx,
  roleId: Id<"roles">,
): Promise<boolean> {
  const links = await ctx.db
    .query("rolePermissions")
    .withIndex("by_roleId_and_permissionId", (q) => q.eq("roleId", roleId))
    .collect();
  return links.some((link) => link.scope === "own_location");
}

async function assertPermission(
  user: Doc<"users">,
  permissions: PermissionMap,
  key: PermissionKey,
  scopeCheck?: ScopeCheck,
): Promise<{ user: Doc<"users">; scope: Scope }> {
  const scope = permissions.get(key);
  if (scope === undefined) {
    throw new ConvexError(`Forbidden: missing permission "${key}".`);
  }
  if (scopeCheck && !(await scopeCheck(scope, user))) {
    throw new ConvexError(`Forbidden: "${key}" is outside your scope.`);
  }
  return { user, scope };
}

/**
 * Standalone check for code that isn't built on the authed* wrappers.
 * Prefer `ctx.requirePermission` inside authedQuery/authedMutation.
 */
export async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  key: PermissionKey,
  scopeCheck?: ScopeCheck,
): Promise<{ user: Doc<"users">; scope: Scope }> {
  const user = await requireCurrentUser(ctx);
  const permissions = await loadPermissions(ctx, user);
  return await assertPermission(user, permissions, key, scopeCheck);
}

/**
 * Whether the user holds the Super Admin role. The Super Admin has every
 * permission AND is exempt from separation-of-duties rules (approving their
 * own requests, confirming their own products, editing others'
 * requisitions) - but not from the lock-out guards on their own account.
 */
export async function loadIsSuperAdmin(
  ctx: QueryCtx | MutationCtx,
  user: Doc<"users">,
): Promise<boolean> {
  if (user.roleId === null) return false;
  const role = await ctx.db.get("roles", user.roleId);
  return role?.key === SUPER_ADMIN_ROLE_KEY;
}

function buildPermissionCtx(
  user: Doc<"users">,
  permissions: PermissionMap,
  isSuperAdmin: boolean,
) {
  return {
    user,
    permissions,
    /** See loadIsSuperAdmin: exempt from separation-of-duties rules. */
    isSuperAdmin,
    can: (key: PermissionKey) => permissions.has(key),
    requirePermission: (key: PermissionKey, scopeCheck?: ScopeCheck) =>
      assertPermission(user, permissions, key, scopeCheck),
  };
}

/** What authedQuery / authedMutation / authedAction add to ctx. */
export type PermissionCtx = ReturnType<typeof buildPermissionCtx>;

/** ctx inside an authedQuery - for helper functions that take it. */
export type AuthedQueryCtx = QueryCtx & PermissionCtx;

/** ctx inside an authedMutation - for helper functions that take it. */
export type AuthedMutationCtx = MutationCtx &
  PermissionCtx & { audit: (entry: AuditEntry) => Promise<void> };

/**
 * Every public query/mutation/action goes through these (see CLAUDE.md,
 * "Permissions & security"). They reject unauthenticated or blocked callers
 * and add `ctx.user`, `ctx.permissions`, `ctx.can(key)` and
 * `ctx.requirePermission(key, scopeCheck?)`. Handlers must still call
 * `ctx.requirePermission` for the specific permission they need.
 */
export const authedQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const user = await requireCurrentUser(ctx);
    return buildPermissionCtx(
      user,
      await loadPermissions(ctx, user),
      await loadIsSuperAdmin(ctx, user),
    );
  }),
);

/**
 * Append-only tables: rows may be inserted but never patched, replaced or
 * deleted. Enforced at runtime on authedMutation's `ctx.db`.
 */
const APPEND_ONLY_RULES: Rules<MutationCtx, DataModel> = {
  auditLogs: { modify: async () => false },
  appliedSeedSteps: { modify: async () => false },
};

/** `ctx.db` that throws on patch/replace/delete of append-only tables. */
export function appendOnlyGuardedDb(ctx: MutationCtx) {
  return wrapDatabaseWriter(ctx, ctx.db, APPEND_ONLY_RULES);
}

/**
 * Also adds `ctx.audit(entry)` - logAudit with the caller as actor - and
 * swaps `ctx.db` for one that refuses to modify append-only tables.
 */
export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const db = appendOnlyGuardedDb(ctx);
    return {
      ...buildPermissionCtx(
        user,
        await loadPermissions(ctx, user),
        await loadIsSuperAdmin(ctx, user),
      ),
      db,
      audit: (entry: AuditEntry) =>
        logAudit({ ...ctx, db }, { ...entry, actorId: user._id }),
    };
  }),
);

/** Actions have no ctx.db, so permissions come through an internal query. */
export const authedAction = customAction(
  action,
  // Explicit return type: this ctx comes from an internal query, whose type
  // would otherwise depend on this very wrapper.
  customCtx(async (ctx): Promise<PermissionCtx> => {
    const user = await requireCurrentUserFromAction(ctx);
    const {
      permissions: entries,
      isSuperAdmin,
    }: { permissions: Array<{ key: string; scope: Scope }>; isSuperAdmin: boolean } =
      await ctx.runQuery(internal.rbac.getPermissionsForUserInternal, {
        userId: user._id,
      });
    const permissions = new Map<PermissionKey, Scope>();
    for (const { key, scope } of entries) {
      if (isPermissionKey(key)) {
        permissions.set(key, scope);
      }
    }
    return buildPermissionCtx(user, permissions, isSuperAdmin);
  }),
);
