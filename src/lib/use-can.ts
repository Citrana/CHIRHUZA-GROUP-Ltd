"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  PERMISSIONS,
  type PermissionKey,
  type PermissionModule,
} from "../../convex/lib/permissions";

/**
 * The signed-in user's permissions as `{ [key]: scope }`, or `undefined`
 * while loading. Convex dedupes the subscription, so every hook below
 * shares one query. Reactive: a role change on the server updates it live.
 */
export function useMyPermissions() {
  return useQuery(api.rbac.getMyPermissions);
}

/**
 * Whether the signed-in user holds `permissionKey`, via their role.
 * `undefined` while loading. For hiding UI only: the server is always the
 * authority (every Convex function checks via requirePermission).
 */
export function useCan(permissionKey: PermissionKey): boolean | undefined {
  const permissions = useMyPermissions();
  if (permissions === undefined) {
    return undefined;
  }
  return permissionKey in permissions;
}

export function holdsAnyInModule(
  permissions: Record<string, unknown>,
  module: PermissionModule,
): boolean {
  return PERMISSIONS.some((p) => p.module === module && p.key in permissions);
}

/** Whether the user holds any permission in `module` (e.g. "sales"). */
export function useCanAnyInModule(
  module: PermissionModule,
): boolean | undefined {
  const permissions = useMyPermissions();
  if (permissions === undefined) {
    return undefined;
  }
  return holdsAnyInModule(permissions, module);
}
