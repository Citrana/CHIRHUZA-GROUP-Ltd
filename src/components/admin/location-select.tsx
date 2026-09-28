"use client";

import type { ComponentProps } from "react";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BUSINESS_UNIT_KEYS } from "../../../convex/lib/businessUnits";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Active locations grouped by service. `value` "" means no location; the
 * empty option reads `emptyLabel` and is disabled when `required`.
 * Requires users.manage (it lists via locations.listOptions).
 */
export function LocationSelect({
  value,
  onValueChange,
  emptyLabel,
  required = false,
  ...props
}: Omit<ComponentProps<typeof NativeSelect>, "value" | "onChange"> & {
  value: Id<"locations"> | "";
  onValueChange: (value: Id<"locations"> | "") => void;
  emptyLabel: string;
}) {
  const tUnits = useTranslations("BusinessUnits");
  const locations = useQuery(api.locations.listOptions);

  return (
    <NativeSelect
      {...props}
      value={value}
      required={required}
      onChange={(event) =>
        onValueChange(event.target.value as Id<"locations"> | "")
      }
    >
      <option value="" disabled={required}>
        {emptyLabel}
      </option>
      {BUSINESS_UNIT_KEYS.map((unitKey) => {
        const group = locations?.filter((l) => l.businessUnitKey === unitKey);
        if (!group?.length) {
          return null;
        }
        return (
          <optgroup key={unitKey} label={tUnits(unitKey)}>
            {group.map((location) => (
              <option key={location._id} value={location._id}>
                {location.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </NativeSelect>
  );
}
