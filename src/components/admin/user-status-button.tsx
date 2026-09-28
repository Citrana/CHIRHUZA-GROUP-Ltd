"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

export function UserStatusButton({ user }: { user: Doc<"users"> }) {
  const t = useTranslations("Admin.users");
  const setUserStatus = useMutation(api.users.setUserStatus);
  const [submitting, setSubmitting] = useState(false);
  const nextStatus = user.status === "active" ? "blocked" : "active";

  async function handleClick() {
    setSubmitting(true);
    try {
      await setUserStatus({ userId: user._id, status: nextStatus });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={submitting}
      onClick={handleClick}
    >
      {nextStatus === "blocked" ? t("block") : t("unblock")}
    </Button>
  );
}
