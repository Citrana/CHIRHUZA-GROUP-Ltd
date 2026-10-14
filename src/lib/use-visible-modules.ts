"use client";

import type { BusinessUnitKey } from "../../convex/lib/businessUnits";
import { SHELL_MODULES, moduleInService, type ShellModule } from "@/lib/shell-modules";
import { holdsAnyInModule, useMyPermissions } from "@/lib/use-can";

/** The service's shell modules the user may see, or `undefined` while loading. */
export function useVisibleModules(service: BusinessUnitKey): ShellModule[] | undefined {
  const permissions = useMyPermissions();
  if (permissions === undefined) {
    return undefined;
  }
  return SHELL_MODULES.filter(
    (m) =>
      moduleInService(m, service) &&
      (("alwaysVisible" in m && m.alwaysVisible) ||
        holdsAnyInModule(permissions, m.permissionModule)),
  );
}
