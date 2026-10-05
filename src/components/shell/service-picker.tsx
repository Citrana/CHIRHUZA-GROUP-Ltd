"use client";

import { House, Scissors, Shirt, Truck, type LucideIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { AppHeader } from "@/components/shell/app-header";
import { useLastService } from "@/lib/service-store";
import { cn } from "@/lib/utils";

const ICONS: Record<BusinessUnitKey, LucideIcon> = {
  hair: Scissors,
  fashion: Shirt,
  housing: House,
  transport: Truck,
};

/** The first screen after login: pick the service to work in. */
export function ServicePicker() {
  const t = useTranslations("ServicePicker");
  const tUnits = useTranslations("BusinessUnits");
  const units = useQuery(api.businessUnits.list);
  const lastService = useLastService();

  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 md:p-8">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">
            {t("title")}
          </h1>
          <p className="mt-1 text-muted-foreground">{t("subtitle")}</p>
        </div>

        {units?.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("noServices")}
          </p>
        ) : null}

        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {units?.map((unit) => {
            const Icon = ICONS[unit.key];
            const content = (
              <>
                <span
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center rounded-xl",
                    unit.enabled
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="size-6" aria-hidden />
                </span>
                <span className="flex flex-col items-start gap-1">
                  <span className="font-heading text-lg font-semibold">
                    {tUnits(unit.key)}
                  </span>
                  {!unit.enabled ? (
                    <Badge variant="secondary">{t("comingSoon")}</Badge>
                  ) : unit.key === lastService ? (
                    <Badge variant="outline">{t("lastUsed")}</Badge>
                  ) : null}
                </span>
              </>
            );
            const cardClass =
              "flex min-h-24 items-center gap-4 rounded-xl border border-border p-4";
            return (
              <li key={unit.key}>
                {unit.enabled ? (
                  <Link
                    href={`/${unit.key}`}
                    className={cn(
                      cardClass,
                      "bg-card transition-colors hover:border-primary hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    )}
                  >
                    {content}
                  </Link>
                ) : (
                  <div
                    aria-disabled="true"
                    className={cn(cardClass, "cursor-not-allowed opacity-60")}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </main>
    </>
  );
}
