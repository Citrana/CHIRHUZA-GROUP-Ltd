"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { NativeSelect } from "@/components/ui/native-select";
import { useRoleText } from "@/components/admin/use-role-text";

type RoleOption = { _id: Id<"roles">; key: string; name: string };

export function UserRoleSelect({
  userId,
  roleId,
  roles,
}: {
  userId: Id<"users">;
  roleId: Id<"roles"> | null;
  roles: RoleOption[];
}) {
  const t = useTranslations("Admin.users");
  const roleText = useRoleText();
  const setUserRole = useMutation(api.users.setUserRole);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  async function handleChange(nextRoleId: Id<"roles">) {
    setSubmitting(true);
    setError(false);
    try {
      await setUserRole({ userId, roleId: nextRoleId });
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        aria-label={t("roleLabel")}
        value={roleId ?? ""}
        disabled={submitting}
        onChange={(event) =>
          handleChange(event.target.value as Id<"roles">)
        }
      >
        {roleId === null ? (
          <option value="" disabled>
            {t("noRole")}
          </option>
        ) : null}
        {roles.map((role) => (
          <option key={role._id} value={role._id}>
            {roleText(role).name}
          </option>
        ))}
      </NativeSelect>
      {error ? (
        <p className="text-xs text-destructive">{t("roleChangeError")}</p>
      ) : null}
    </div>
  );
}
