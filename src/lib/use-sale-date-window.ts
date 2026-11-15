"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { earliestSaleDay } from "../../convex/lib/sales";
import { businessDayOf } from "../../convex/lib/time";

/**
 * The days the signed-in user may date a sale, a correction or a repayment
 * on: today back to `earliest` (7 days, or any past day from 1 Jan 2026
 * for the Super Admin - `anyPastDay`). From the server (sales.dateWindow);
 * until it answers, the usual 7-day window. For the date pickers only: the
 * server applies the same rule.
 */
export function useSaleDateWindow(): { today: string; earliest: string; anyPastDay: boolean; loaded: boolean } {
  const window = useQuery(api.sales.dateWindow, {});
  const [today] = useState(() => businessDayOf(Date.now()));
  if (window) return { ...window, loaded: true };
  return { today, earliest: earliestSaleDay(today), anyPastDay: false, loaded: false };
}
