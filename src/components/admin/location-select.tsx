"use client";

import type { ComponentProps } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Active locations (shared by every service). `value` "" means no location; the
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
      {locations?.map((location) => (
        <option key={location._id} value={location._id}>
          {location.name}
        </option>
      ))}
    </NativeSelect>
  );
}
