"use client";

import { ArrowLeftRight, House, Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { useVisibleModules } from "@/lib/use-visible-modules";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { PendingApprovalsBadge } from "@/components/approvals/pending-approvals-badge";

/**
 * The shell's module menu: Home plus every module the user has a
 * permission in. Used both in the desktop sidebar and the mobile sheet.
 */
export function ModuleNav({
  service,
  onNavigate,
}: {
  service: BusinessUnitKey;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Shell");
  const tModules = useTranslations("Modules");
  const tHeader = useTranslations("AppHeader");
  const pathname = usePathname();
  const modules = useVisibleModules();
  const tNav = useTranslations("Nav");
  const canManageProductSettings = useCan("products.settings");

  const homeHref = `/${service}`;
  const settingsHref = `/${service}/settings`;
  const settingsActive = pathname === settingsHref;
  const items = [
    { key: "home", href: homeHref, label: t("home"), icon: House },
    ...(modules ?? []).map((m) => ({
      key: m.key,
      href: `/${service}/${m.key}`,
      label: tModules(m.key),
      icon: m.icon,
    })),
  ];

  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label={t("modules")}>
      {items.map(({ key, href, label, icon: Icon }) => {
        const active =
          href === homeHref
            ? pathname === homeHref
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {label}
            {key === "approvals" ? (
              <PendingApprovalsBadge
                service={service}
                className={cn(
                  "ml-auto",
                  active && "bg-primary-foreground text-primary",
                )}
              />
            ) : null}
          </Link>
        );
      })}
      {/* Bottom group: settings (if allowed), then switch service. */}
      <div className="mt-auto flex flex-col gap-1 border-t border-border pt-2">
        {canManageProductSettings ? (
          <Link
            href={settingsHref}
            onClick={onNavigate}
            aria-current={settingsActive ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors",
              settingsActive
                ? "bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Settings className="size-4 shrink-0" aria-hidden />
            {tNav("productSettings")}
          </Link>
        ) : null}
        <Link
          href="/"
          onClick={onNavigate}
          className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftRight className="size-4 shrink-0" aria-hidden />
          {tHeader("switchService")}
        </Link>
      </div>
    </nav>
  );
}
