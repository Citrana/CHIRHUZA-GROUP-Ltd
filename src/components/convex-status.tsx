"use client";

import { useTranslations } from "next-intl";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";

export function ConvexStatus() {
  const t = useTranslations("Home");
  const health = useQuery(api.healthCheck.ping);

  if (health === undefined) {
    return <Badge variant="secondary">{t("statusChecking")}</Badge>;
  }
  if (health.ok) {
    return (
      <Badge className="bg-accent text-accent-foreground">
        {t("statusConnected")}
      </Badge>
    );
  }
  return <Badge variant="destructive">{t("statusUnreachable")}</Badge>;
}
