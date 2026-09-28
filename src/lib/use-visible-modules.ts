"use client";

import { SHELL_MODULES, type ShellModule } from "@/lib/shell-modules";
import { holdsAnyInModule, useMyPermissions } from "@/lib/use-can";

/** Shell modules the user may see, or `undefined` while loading. */
export function useVisibleModules(): ShellModule[] | undefined {
  const permissions = useMyPermissions();
  if (permissions === undefined) {
    return undefined;
  }
  return SHELL_MODULES.filter((m) =>
    holdsAnyInModule(permissions, m.permissionModule),
  );
}
