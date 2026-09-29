"use client";

import { useTranslations } from "next-intl";
import type { ProductStatus } from "../../../convex/lib/products";
import { Badge } from "@/components/ui/badge";

const VARIANTS: Record<ProductStatus, "default" | "outline" | "secondary"> = {
  active: "default",
  pending_confirmation: "outline",
  archived: "secondary",
};

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const t = useTranslations("Products");
  return <Badge variant={VARIANTS[status]}>{t(`statuses.${status}`)}</Badge>;
}
