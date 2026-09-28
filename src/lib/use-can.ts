"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { PermissionKey } from "../../convex/lib/permissions";

/**
 * Whether the signed-in user holds `permissionKey`, via their role.
 * `undefined` while loading. For hiding UI only: the server is always the
 * authority (every Convex function checks via requirePermission).
 * Reactive: a role change on the server updates this live. Convex dedupes
 * the underlying subscription, so calling it in many components is cheap.
 */
export function useCan(permissionKey: PermissionKey): boolean | undefined {
  const permissions = useQuery(api.rbac.getMyPermissions);
  if (permissions === undefined) {
    return undefined;
  }
  return permissionKey in permissions;
}
