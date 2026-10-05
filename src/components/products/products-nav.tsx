"use client";

import { useTranslations } from "next-intl";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link, usePathname } from "@/i18n/navigation";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/**
 * Tabs across the Products area: the catalogue, and the price list (shown
 * to people with stock or sales access, like the server requires).
 */
export function ProductsNav({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Products.tabs");
  const pathname = usePathname();
  const canStock = useCan("stock.view");
  const canSalesView = useCan("sales.view");
  const canSell = useCan("sales.create");
  if (!canStock && !canSalesView && !canSell) return null;
  const base = `/${service}/products`;
  const tabs = [
    { key: "catalogue", href: base, active: pathname === base },
    { key: "prices", href: `${base}/prices`, active: pathname.startsWith(`${base}/prices`) },
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
                tab.active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
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
