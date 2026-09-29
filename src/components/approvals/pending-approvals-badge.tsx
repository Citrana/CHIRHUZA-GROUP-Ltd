"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { cn } from "@/lib/utils";

/**
 * Count of pending approvals in this service that the user can decide
 * ("waiting on me"). Renders nothing at 0 or while loading.
 */
export function PendingApprovalsBadge({
  service,
  className,
}: {
  service: BusinessUnitKey;
  className?: string;
}) {
  const t = useTranslations("Approvals");
  const count = useQuery(api.approvals.pendingCount, { businessUnitKey: service });

  if (!count) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums",
        className,
      )}
      aria-label={t("pendingBadge", { count })}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
