import { v, ConvexError, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireBusinessUnit, type BusinessUnitKey } from "./businessUnits";
import { addBusinessDays, isBusinessDay } from "./time";

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

// ------------------------------------------------------------------ clients

/** A client is a company or a private person. */
export const CLIENT_KINDS = ["company", "person"] as const;
export const clientKindValidator = v.union(v.literal("company"), v.literal("person"));
export type ClientKind = Infer<typeof clientKindValidator>;

export const MAX_CLIENT_NAME_LENGTH = 120;
export const MAX_PHONE_LENGTH = 30;
export const MAX_EMAIL_LENGTH = 120;
export const MAX_ADDRESS_LENGTH = 200;

/** A plain email shape check (something@domain.tld), lowercased. */
export function cleanEmail(value: string | undefined): string | undefined {
  const email = cleanText(value, { label: "Email", max: MAX_EMAIL_LENGTH })?.toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ConvexError("The email address isn't valid.");
  return email;
}

// ---------------------------------------------------------------- contracts

/** How a client or a driver is paid. */
export const TRANSPORT_PAYMENT_METHODS = ["cash", "mobile_money", "bank"] as const;
export const transportPaymentMethodValidator = v.union(v.literal("cash"), v.literal("mobile_money"), v.literal("bank"));
export type TransportPaymentMethod = Infer<typeof transportPaymentMethodValidator>;

/** Client money on a contract: a payment, or (negative) a reversal of a wrong one. */
export const contractPaymentKindValidator = v.union(v.literal("payment"), v.literal("reversal"));
export type ContractPaymentKind = Infer<typeof contractPaymentKindValidator>;

/** A driver payment waits for the Chief Admin's approval. */
export const driverPaymentStatusValidator = v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"));
export type DriverPaymentStatus = Infer<typeof driverPaymentStatusValidator>;

export const contractPaymentStatusValidator = v.union(v.literal("open"), v.literal("settled"));
export type ContractPaymentStatus = Infer<typeof contractPaymentStatusValidator>;

/** A contract lasts 1 to MAX_CONTRACT_DAYS days. */
export const MAX_CONTRACT_DAYS = 366;

/** Whole days from 1 to MAX_CONTRACT_DAYS. */
export function checkDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_CONTRACT_DAYS) {
    throw new ConvexError(`A contract lasts 1 to ${MAX_CONTRACT_DAYS} days.`);
  }
  return days;
}

/** The last day (YYYY-MM-DD) of a contract starting on `startDay` for `days` days. */
export function endDay(startDay: string, days: number): string {
  if (!isBusinessDay(startDay)) throw new ConvexError("The start date must be YYYY-MM-DD.");
  return addBusinessDays(startDay, checkDays(days) - 1);
}

/** Whether two inclusive day ranges share at least one day. */
export function daysOverlap(a: { startDay: string; endDay: string }, b: { startDay: string; endDay: string }): boolean {
  return a.startDay <= b.endDay && b.startDay <= a.endDay;
}

/**
 * A total (cents) spread over `days` days in whole cents: equal shares,
 * the leftover cents on the first days. The shares add up to the total.
 */
export function spreadOverDays(total: number, days: number): number[] {
  const base = Math.trunc(total / days);
  const left = total - base * days;
  return Array.from({ length: days }, (_, i) => base + (i < Math.abs(left) ? Math.sign(left) : 0));
}

/** What the client still owes on a contract (cents). */
export function contractBalance(contract: Pick<Doc<"contracts">, "totalAmount" | "amountPaid">): number {
  return contract.totalAmount - contract.amountPaid;
}

/** What the driver is still owed on a contract (cents, approved payments only). */
export function driverBalance(contract: Pick<Doc<"contracts">, "driverPayTotal" | "driverPaid">): number {
  return contract.driverPayTotal - contract.driverPaid;
}

/** Money in whole cents from 0. */
export function checkCents(cents: number, label: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new ConvexError(`${label} must be whole cents from 0.`);
  return cents;
}
