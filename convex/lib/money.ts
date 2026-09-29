import { v, type Infer } from "convex/values";

/**
 * Money helpers (CLAUDE.md "Money"): amounts are integer minor units
 * (cents) plus a currency. Shared by the server and the UI.
 */

export const currencyValidator = v.union(v.literal("USD"), v.literal("CDF"));
export type Currency = Infer<typeof currencyValidator>;

/** Stock purchasing is done in USD only. */
export const usdValidator = v.literal("USD");

/**
 * "12", "12.5", "12.50", "1,234.56" → cents. Returns null for anything
 * else (negative, more than 2 decimals, not a number).
 */
export function parseMoneyToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/[\s,]/g, "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents → "12.50" for editing (no currency symbol, no grouping). */
export function minorToInput(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents → "$12.50" / "12,50 $US", in the user's locale. */
export function formatMoney(minor: number, currency: Currency, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Whether a snapshot field (audit entry, approval payload) holds money in
 * minor units: `amount`, or a name ending in Amount / Total / Cost / Price
 * (`unitCost`, `purchasedTotal`, ...). Name money fields this way so the
 * Approvals and Audit pages show them formatted, not as raw cents.
 */
export function isMoneyField(key: string): boolean {
  return key === "amount" || /(Amount|Total|Cost|Price)$/.test(key);
}

/** The first valid `currency` among the given snapshots, if any. */
export function snapshotCurrency(
  ...snapshots: Array<Record<string, unknown> | null | undefined>
): Currency | null {
  for (const snapshot of snapshots) {
    const currency = snapshot?.currency;
    if (currency === "USD" || currency === "CDF") return currency;
  }
  return null;
}
