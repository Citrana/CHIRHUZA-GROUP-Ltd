import { v, ConvexError, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireBusinessUnit, type BusinessUnitKey } from "./businessUnits";

/**
 * Transport (CLAUDE.md "Transport"): cars, known by their plate number,
 * each with one driver, rented out on contracts priced per day. Cars are
 * never deleted - a car leaves the fleet as `retired`; drivers likewise
 * become `inactive`. Money in USD cents.
 */

export const CAR_STATUSES = ["active", "retired"] as const;
export const carStatusValidator = v.union(v.literal("active"), v.literal("retired"));
export type CarStatus = Infer<typeof carStatusValidator>;

export const DRIVER_STATUSES = ["active", "inactive"] as const;
export const driverStatusValidator = v.union(v.literal("active"), v.literal("inactive"));
export type DriverStatus = Infer<typeof driverStatusValidator>;

/** The services that run a fleet (only Transport today). */
export const FLEET_SERVICES: readonly BusinessUnitKey[] = ["transport"];

/** The business unit, if it runs a fleet; throws otherwise. */
export async function requireFleetUnit(ctx: QueryCtx, key: BusinessUnitKey): Promise<Doc<"businessUnits">> {
  if (!FLEET_SERVICES.includes(key)) throw new ConvexError("This service has no cars.");
  return await requireBusinessUnit(ctx, key);
}

export const MAX_PLATE_LENGTH = 20;
export const MAX_NAME_LENGTH = 100;
export const MAX_NOTE_LENGTH = 300;

/** A plate as shown: trimmed, upper-cased, single spaces ("5432 AB 07"). */
export function cleanPlate(plate: string): string {
  return plate.trim().replace(/\s+/g, " ").toUpperCase();
}

/** A plate for uniqueness: no spaces or dashes ("5432AB07"). */
export function plateKey(plate: string): string {
  return cleanPlate(plate).replace(/[\s-]/g, "");
}

/** A trimmed text with single spaces; throws when empty (if required) or too long. */
export function cleanText(
  value: string | undefined,
  { label, max, required = false }: { label: string; max: number; required?: boolean },
): string | undefined {
  const text = value?.trim().replace(/\s+/g, " ") ?? "";
  if (!text) {
    if (required) throw new ConvexError(`${label} is required.`);
    return undefined;
  }
  if (text.length > max) throw new ConvexError(`${label} is too long (at most ${max} characters).`);
  return text;
}

/** A day rate in whole cents, from 0. */
export function checkDayRate(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new ConvexError("The day rate must be whole cents from 0.");
  return cents;
}
