"use client";

import { useTranslations } from "next-intl";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/** Tabs across the contracts area: the contracts, and the clients. */
export function ContractsNav({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Contracts.tabs");
  const pathname = usePathname();
  const base = `/${service}/contracts`;
  const tabs = [
    { key: "contracts", href: base, active: pathname === base },
    { key: "clients", href: `${base}/clients`, active: pathname.startsWith(`${base}/clients`) },
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
