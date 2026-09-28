"use client";

import { ArrowLeftRight, House } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { useVisibleModules } from "@/lib/use-visible-modules";
import { cn } from "@/lib/utils";

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

  const homeHref = `/${service}`;
  const items = [
    { href: homeHref, label: t("home"), icon: House },
    ...(modules ?? []).map((m) => ({
      href: `/${service}/${m.key}`,
      label: tModules(m.key),
      icon: m.icon,
    })),
  ];

  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label={t("modules")}>
      {items.map(({ href, label, icon: Icon }) => {
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
          </Link>
        );
      })}
      <Link
        href="/"
        onClick={onNavigate}
        className="mt-auto flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeftRight className="size-4 shrink-0" aria-hidden />
        {tHeader("switchService")}
      </Link>
    </nav>
  );
}
