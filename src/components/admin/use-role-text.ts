"use client";

import { useTranslations, type Messages } from "next-intl";

type RoleKey = keyof Messages["Roles"];

/**
 * Translated name/description for a role. System roles are translated by
 * their stable `key`; any other role falls back to its stored text.
 */
export function useRoleText() {
  const t = useTranslations("Roles");
  return (role: { key: string; name: string; description?: string }) => {
    const key = role.key as RoleKey;
    const known = t.has(`${key}.name`);
    return {
      name: known ? t(`${key}.name`) : role.name,
      description: known ? t(`${key}.description`) : (role.description ?? ""),
    };
  };
}
