"use client";

import { ShoppingCart, Plus, X } from "lucide-react";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link, usePathname } from "@/i18n/navigation";
import { useCan } from "@/lib/use-can";
import { useLastService } from "@/lib/service-store";
import { setNewSaleFabState, useNewSaleFabState } from "@/lib/new-sale-fab-store";
import { cn } from "@/lib/utils";

/** Pages with their own fixed bottom bar, where the button would be in the way. */
const HIDDEN_ON = [/\/sales\/new$/, /\/sales\/[^/]+\/exchange$/];

const ROUND =
  "inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The floating New sale button, bottom right on every page, for people who
 * can record sales. It opens the existing sale page. The user can tuck it
 * away into a small icon and bring it back; the choice is kept per browser.
 * `service` comes from the URL; admin pages fall back to the last service.
 * Hiding it is UI only - the server still checks `sales.create`.
 */
export function NewSaleFab({ service }: { service?: BusinessUnitKey }) {
  const t = useTranslations("NewSaleFab");
  const canSell = useCan("sales.create");
  const lastService = useLastService();
  const state = useNewSaleFabState();
  const pathname = usePathname();
  const target = service ?? lastService;
  // Only needed on admin pages, to skip a last service that was switched off.
  const units = useQuery(api.businessUnits.list, !service && target && canSell ? {} : "skip");

  if (canSell !== true || !target || HIDDEN_ON.some((re) => re.test(pathname))) return null;
  if (!service && units?.find((u) => u.key === target)?.enabled !== true) return null;

  return (
    <div
      className="fixed right-4 z-30 flex items-center gap-1"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
      {state === "hidden" ? (
        <button
          type="button"
          onClick={() => setNewSaleFabState("shown")}
          aria-label={t("show")}
          title={t("show")}
          className={cn(ROUND, "size-11")}
        >
          <ShoppingCart className="size-5" aria-hidden />
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setNewSaleFabState("hidden")}
            aria-label={t("hide")}
            title={t("hide")}
            className="group inline-flex size-11 items-center justify-center rounded-full outline-none"
          >
            <span className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors group-hover:text-foreground group-focus-visible:ring-3 group-focus-visible:ring-ring">
              <X className="size-4" aria-hidden />
            </span>
          </button>
          <Link href={`/${target}/sales/new`} aria-label={t("label")} className={cn(ROUND, "min-h-14 gap-2 px-5 font-semibold")}>
            <span className="relative inline-flex" aria-hidden>
              <ShoppingCart className="size-5" />
              <Plus className="absolute -top-1.5 -right-1.5 size-3 rounded-full bg-primary-foreground text-primary" strokeWidth={3} />
            </span>
            <span className="text-sm md:hidden">{t("shortLabel")}</span>
            <span className="hidden text-sm md:inline">{t("label")}</span>
          </Link>
        </>
      )}
    </div>
  );
}
