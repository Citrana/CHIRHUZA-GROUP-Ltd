"use client";

import { useTranslations } from "next-intl";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/** Tabs across the fleet area: cars, and the drivers. */
export function FleetNav({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Fleet.tabs");
  const pathname = usePathname();
  const base = `/${service}/cars`;
  const tabs = [
    { key: "cars", href: base, active: pathname === base },
    { key: "drivers", href: `${base}/drivers`, active: pathname.startsWith(`${base}/drivers`) },
  ] as const;
  return (
    <nav aria-label={t("label")} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium",
                tab.active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
