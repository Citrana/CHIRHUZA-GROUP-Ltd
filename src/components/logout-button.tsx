"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const t = useTranslations("Auth");
  const { signOut } = useAuthActions();

  return (
    <Button variant="outline" size="sm" onClick={() => void signOut()}>
      {t("logout")}
    </Button>
  );
}
