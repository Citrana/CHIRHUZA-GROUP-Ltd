"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { AppHeader } from "@/components/shell/app-header";
import { ModuleNav } from "@/components/shell/module-nav";
import { setLastService } from "@/lib/service-store";

/**
 * App shell for one service (/[service]/...): header, a module sidebar on
 * desktop, and the same menu in a slide-in sheet on phones. Disabled
 * services show a "coming soon" screen instead of their modules.
 */
export function ServiceShell({
  service,
  children,
}: {
  service: BusinessUnitKey;
  children: ReactNode;
}) {
  const t = useTranslations("Shell");
  const tHeader = useTranslations("AppHeader");
  const tUnits = useTranslations("BusinessUnits");
  const units = useQuery(api.businessUnits.list);
  const [menuOpen, setMenuOpen] = useState(false);
  const unit = units?.find((u) => u.key === service);
  const enabled = unit?.enabled === true;

  useEffect(() => {
    if (enabled) {
      setLastService(service);
    }
  }, [enabled, service]);

  if (units === undefined) {
    return <AppHeader service={service} />;
  }

  if (!enabled) {
    return (
      <>
        <AppHeader service={service} />
        <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="font-heading text-xl font-semibold">
            {t("serviceUnavailable", { service: tUnits(service) })}
          </p>
          <Link href="/" className="text-primary underline-offset-4 hover:underline">
            {t("backToServices")}
          </Link>
        </main>
      </>
    );
  }

  const menuButton = (
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 md:hidden"
            aria-label={tHeader("openMenu")}
          />
        }
      >
        <Menu />
      </SheetTrigger>
      <SheetContent side="left" className="gap-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{tUnits(service)}</SheetTitle>
        </SheetHeader>
        <ModuleNav service={service} onNavigate={() => setMenuOpen(false)} />
      </SheetContent>
    </Sheet>
  );

  return (
    <>
      <AppHeader service={service} menuButton={menuButton} />
      <div className="flex flex-1">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 border-r border-border md:block">
          <ModuleNav service={service} />
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </>
  );
}
