/**
 * The encouragement card after a sale (sale form): the "gift" grows with
 * the products the shop sold that day, and a quote rotates.
 */

export const CELEBRATION_TIERS = ["seedling", "star", "trophy", "crown"] as const;
export type CelebrationTier = (typeof CELEBRATION_TIERS)[number];

/** 1-9 seedling, 10-19 star, 20-39 trophy, 40+ crown. */
export function tierFor(units: number): CelebrationTier {
  if (units >= 40) return "crown";
  if (units >= 20) return "trophy";
  if (units >= 10) return "star";
  return "seedling";
}

/** Quote message keys (SaleCelebration.quotes in messages/{en,fr}.json). */
export const QUOTE_KEYS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11", "q12"] as const;
export const QUOTE_COUNT = QUOTE_KEYS.length;

/** A random quote index (0-based), never the previous one. */
export function nextQuote(previous: number | null, random: () => number = Math.random): number {
  const pick = Math.floor(random() * (previous === null ? QUOTE_COUNT : QUOTE_COUNT - 1));
  return previous !== null && pick >= previous ? pick + 1 : pick;
}

/** The greeting name: first word of the user's name, else nothing. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}
