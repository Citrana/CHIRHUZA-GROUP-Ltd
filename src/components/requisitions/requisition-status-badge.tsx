"use client";

import { useTranslations } from "next-intl";
import type { RequisitionStatus } from "../../../convex/lib/requisitions";
import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<RequisitionStatus, "default" | "outline" | "secondary" | "destructive"> = {
  draft: "secondary",
  submitted: "outline",
  approved: "default",
  rejected: "destructive",
  purchasing: "outline",
  closed: "secondary",
};

export function RequisitionStatusBadge({ status }: { status: RequisitionStatus }) {
  const t = useTranslations("Requisitions");
  return <Badge variant={VARIANTS[status]}>{t(`statuses.${status}`)}</Badge>;
}
