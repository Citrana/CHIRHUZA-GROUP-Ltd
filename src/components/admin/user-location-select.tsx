"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { LocationSelect } from "@/components/admin/location-select";

export function UserLocationSelect({
  userId,
  locationId,
  required,
}: {
  userId: Id<"users">;
  locationId: Id<"locations"> | undefined;
  required: boolean;
}) {
  const t = useTranslations("Admin.users");
  const setUserLocation = useMutation(api.users.setUserLocation);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  async function handleChange(next: Id<"locations"> | "") {
    setSubmitting(true);
    setError(false);
    try {
      await setUserLocation({ userId, locationId: next === "" ? null : next });
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <LocationSelect
        aria-label={t("locationLabel")}
        value={locationId ?? ""}
        onValueChange={handleChange}
        emptyLabel={t("noLocation")}
        required={required}
        disabled={submitting}
      />
      {error ? (
        <p className="text-xs text-destructive">{t("locationChangeError")}</p>
      ) : null}
    </div>
  );
}
