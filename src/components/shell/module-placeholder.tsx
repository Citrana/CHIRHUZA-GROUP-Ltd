"use client";

import { useTranslations } from "next-intl";
import type { ShellModuleKey } from "@/lib/shell-modules";
import { findShellModule } from "@/lib/shell-modules";
import { useCanAnyInModule } from "@/lib/use-can";

/**
 * Placeholder for modules not built yet. Hidden-UI check only: each real
 * module's Convex functions enforce their own permissions server-side.
 */
export function ModulePlaceholder({ moduleKey }: { moduleKey: ShellModuleKey }) {
  const t = useTranslations("Shell");
  const tModules = useTranslations("Modules");
  const shellModule = findShellModule(moduleKey)!;
  const allowed = useCanAnyInModule(shellModule.permissionModule);
  const Icon = shellModule.icon;

  if (allowed === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-bold text-primary">
        {tModules(moduleKey)}
      </h1>
      {allowed ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
          <Icon className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">{t("comingSoonTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("comingSoonBody")}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>
      )}
    </div>
  );
}
