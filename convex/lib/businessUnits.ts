import { v, type Infer } from "convex/values";

/**
 * The four business units (services). Seeded into `businessUnits` by
 * `businessUnits:seedBusinessUnits`. `enabledByDefault` applies only when a
 * unit is first inserted; the seed never overwrites `enabled` afterwards.
 * `name` is an English fallback - the UI translates via `BusinessUnits.<key>`.
 */
export const BUSINESS_UNITS = [
  { key: "hair", name: "Hair", enabledByDefault: true },
  { key: "fashion", name: "Fashion", enabledByDefault: false },
  { key: "housing", name: "Housing", enabledByDefault: false },
  { key: "transport", name: "Transport", enabledByDefault: false },
] as const;

export const businessUnitKeyValidator = v.union(
  v.literal("hair"),
  v.literal("fashion"),
  v.literal("housing"),
  v.literal("transport"),
);
export type BusinessUnitKey = Infer<typeof businessUnitKeyValidator>;

export const BUSINESS_UNIT_KEYS: readonly BusinessUnitKey[] =
  BUSINESS_UNITS.map((u) => u.key);

export function isBusinessUnitKey(key: string): key is BusinessUnitKey {
  return (BUSINESS_UNIT_KEYS as readonly string[]).includes(key);
}

export const locationTypeValidator = v.union(
  v.literal("shop"),
  v.literal("warehouse"),
);
export type LocationType = Infer<typeof locationTypeValidator>;
