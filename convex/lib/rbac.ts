import { ConvexError } from "convex/values";
import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireCurrentUser, requireCurrentUserFromAction } from "./auth";
import { isPermissionKey, type PermissionKey, type Scope } from "./permissions";

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

function buildPermissionCtx(user: Doc<"users">, permissions: PermissionMap) {
  return {
    user,
    permissions,
    can: (key: PermissionKey) => permissions.has(key),
    requirePermission: (key: PermissionKey, scopeCheck?: ScopeCheck) =>
      assertPermission(user, permissions, key, scopeCheck),
  };
}

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
    return buildPermissionCtx(user, await loadPermissions(ctx, user));
  }),
);

export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const user = await requireCurrentUser(ctx);
    return buildPermissionCtx(user, await loadPermissions(ctx, user));
  }),
);

/** Actions have no ctx.db, so permissions come through an internal query. */
export const authedAction = customAction(
  action,
  customCtx(async (ctx) => {
    const user = await requireCurrentUserFromAction(ctx);
    const entries: Array<{ key: string; scope: Scope }> = await ctx.runQuery(
      internal.rbac.getPermissionsForUserInternal,
      { userId: user._id },
    );
    const permissions = new Map<PermissionKey, Scope>();
    for (const { key, scope } of entries) {
      if (isPermissionKey(key)) {
        permissions.set(key, scope);
      }
    }
    return buildPermissionCtx(user, permissions);
  }),
);
