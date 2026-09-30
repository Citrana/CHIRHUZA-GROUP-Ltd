"use client";

import { useTranslations } from "next-intl";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "overview", path: "" },
  { key: "batches", path: "/batches" },
  { key: "distributions", path: "/distributions" },
] as const;

/** Tabs across the Stock module: overview, purchase batches, distributions. */
export function StockNav({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Inventory.tabs");
  const pathname = usePathname();
  const base = `/${service}/stock`;
  return (
    <nav aria-label={t("label")} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {TABS.map((tab) => {
          const href = `${base}${tab.path}`;
          const active = tab.path === "" ? pathname === base : pathname.startsWith(href);
          return (
            <li key={tab.key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(tab.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
