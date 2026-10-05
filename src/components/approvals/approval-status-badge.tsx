"use client";

import { useTranslations } from "next-intl";
import type { ApprovalStatus } from "../../../convex/lib/approvalTypes";
import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<ApprovalStatus, "outline" | "default" | "destructive"> = {
  pending: "outline",
  approved: "default",
  rejected: "destructive",
};

export function ApprovalStatusBadge({
  status,
  className,
}: {
  status: ApprovalStatus;
  className?: string;
}) {
  const t = useTranslations("Approvals");
  return (
    <Badge variant={VARIANTS[status]} className={className}>
      {t(`statuses.${status}`)}
    </Badge>
  );
}
