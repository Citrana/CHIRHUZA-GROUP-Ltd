"use client";

import { useTranslations } from "next-intl";
import type { StockBatchStatus } from "../../../convex/lib/stockBatches";
import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<StockBatchStatus, "default" | "outline" | "secondary"> = {
  draft: "secondary",
  purchased: "outline",
  approved: "default",
  shipped: "outline",
  arrived: "outline",
  received: "default",
};

export function StockBatchStatusBadge({ status }: { status: StockBatchStatus }) {
  const t = useTranslations("StockBatches");
  return <Badge variant={VARIANTS[status]}>{t(`statuses.${status}`)}</Badge>;
}
