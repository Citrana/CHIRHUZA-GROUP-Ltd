"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowLeftRight, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LogoutButton } from "@/components/logout-button";
import { AdminLinks } from "@/components/shell/admin-links";
import { useLastService } from "@/lib/service-store";

/**
 * The app-wide header: brand, current service + switcher, and an account
 * menu (admin links, language, logout). On phones the account menu lives
 * in a sheet; from `xl` up it is inline (the admin links need the room).
 *
 * - `service`: the service being worked in (inside /[service]).
 * - `backToLastService`: on pages outside a service (admin), offer a link
 *   back to the last service entered.
 * - `menuButton`: slot for the shell's mobile module-menu button.
 */
export function AppHeader({
  service,
  backToLastService = false,
  menuButton,
}: {
  service?: BusinessUnitKey;
  backToLastService?: boolean;
  menuButton?: ReactNode;
}) {
  const t = useTranslations("AppHeader");
  const tUnits = useTranslations("BusinessUnits");
  const lastService = useLastService();
  const [accountOpen, setAccountOpen] = useState(false);
  const closeAccount = () => setAccountOpen(false);

  const serviceLink = service ? (
    <Link
      href="/"
      onClick={closeAccount}
      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftRight className="size-4" aria-hidden />
      {t("switchService")}
    </Link>
  ) : backToLastService && lastService ? (
    <Link
      href={`/${lastService}`}
      onClick={closeAccount}
      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("backToService", { service: tUnits(lastService) })}
    </Link>
  ) : null;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
      <div className="flex h-14 items-center gap-2 px-4 md:px-6">
        {menuButton}
        <Link
          href="/"
          className="truncate font-heading text-base font-bold tracking-tight text-primary sm:text-lg"
        >
          {t("brand")}
        </Link>
        {service ? (
          <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
            {tUnits(service)}
          </span>
        ) : null}

        <div className="ml-auto hidden items-center gap-4 xl:flex">
          {serviceLink}
          <AdminLinks className="flex items-center gap-4" />
          <LocaleSwitcher />
          <LogoutButton />
        </div>

        <Sheet open={accountOpen} onOpenChange={setAccountOpen}>
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto xl:hidden"
                aria-label={t("account")}
              />
            }
          >
            <UserRound />
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t("account")}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-4">
              {serviceLink}
              <AdminLinks
                className="flex flex-col gap-4"
                linkClassName="text-base"
                onNavigate={closeAccount}
              />
              <LocaleSwitcher />
              <div>
                <LogoutButton />
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
