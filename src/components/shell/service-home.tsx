"use client";

import { useTranslations } from "next-intl";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link } from "@/i18n/navigation";
import { useVisibleModules } from "@/lib/use-visible-modules";
import { PendingApprovalsBadge } from "@/components/approvals/pending-approvals-badge";

/** A service's landing page: a tappable grid of the user's modules. */
export function ServiceHome({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Shell");
  const tModules = useTranslations("Modules");
  const tUnits = useTranslations("BusinessUnits");
  const modules = useVisibleModules();

  if (modules === undefined) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">
          {tUnits(service)}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {modules.length > 0 ? t("homeSubtitle") : t("noModules")}
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {modules.map(({ key, icon: Icon }) => (
          <li key={key}>
            <Link
              href={`/${service}/${key}`}
              className="flex min-h-24 flex-col items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-muted/50"
            >
              <span className="flex w-full items-start justify-between gap-2">
                <Icon className="size-6 text-primary" aria-hidden />
                {key === "approvals" ? (
                  <PendingApprovalsBadge service={service} />
                ) : null}
              </span>
              <span className="font-medium">{tModules(key)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
