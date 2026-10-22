"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "../../../convex/lib/money";
import { MAX_CONTRACT_DAYS } from "../../../convex/lib/transport";
import { addBusinessDays, isBusinessDay } from "../../../convex/lib/time";
import { useDayFormat } from "@/components/fleet/contract-bits";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";

/** A contract's dates and prices, as edited in the form (cents; null = not entered). */
export type ContractTerms = {
  startDay: string;
  days: string;
  dayRate: number | null;
  /** The agreed total when it differs from price per day × days; null = the computed one. */
  agreedTotal: number | null;
  priceChangeReason: string;
  driverDayRate: number | null;
};

export function termsDays(terms: ContractTerms): number | null {
  const days = Number(terms.days);
  return Number.isSafeInteger(days) && days >= 1 && days <= MAX_CONTRACT_DAYS ? days : null;
}

export function computedTotal(terms: ContractTerms): number | null {
  const days = termsDays(terms);
  return days !== null && terms.dayRate !== null ? terms.dayRate * days : null;
}

/** What's missing before the terms can be saved (an i18n key), or null. */
export function termsProblem(terms: ContractTerms): "missingFields" | "reasonRequired" | null {
  if (!isBusinessDay(terms.startDay) || termsDays(terms) === null || terms.dayRate === null || terms.driverDayRate === null) {
    return "missingFields";
  }
  if (terms.agreedTotal !== null && terms.agreedTotal !== computedTotal(terms) && !terms.priceChangeReason.trim()) {
    return "reasonRequired";
  }
  return null;
}

/** The server's price args from the terms (call after termsProblem returned null). */
export function termsArgs(terms: ContractTerms) {
  const changed = terms.agreedTotal !== null && terms.agreedTotal !== computedTotal(terms);
  return {
    startDay: terms.startDay,
    days: termsDays(terms)!,
    dayRate: terms.dayRate!,
    driverDayRate: terms.driverDayRate!,
    ...(changed ? { agreedTotal: terms.agreedTotal!, priceChangeReason: terms.priceChangeReason } : {}),
  };
}

/**
 * Start date + days (end date shown), price per day (total shown, and a
 * different agreed total with its reason), and the driver's pay per day
 * (driver total shown).
 */
export function ContractTermsFields({ terms, onChange }: { terms: ContractTerms; onChange: (next: ContractTerms) => void }) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const day = useDayFormat();
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const days = termsDays(terms);
  const total = computedTotal(terms);
  const set = (patch: Partial<ContractTerms>) => onChange({ ...terms, ...patch });
  const totalChanged = terms.agreedTotal !== null && terms.agreedTotal !== total;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-start" required>
            {t("startLabel")}
          </Label>
          <Input id="contract-start" type="date" value={terms.startDay} onChange={(e) => set({ startDay: e.target.value })} required className="h-11" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-days" required>
            {t("daysLabel")}
          </Label>
          <Input
            id="contract-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_CONTRACT_DAYS}
            step={1}
            value={terms.days}
            onChange={(e) => set({ days: e.target.value })}
            required
            className="h-11"
          />
        </div>
      </div>
      {days !== null && isBusinessDay(terms.startDay) ? (
        <p className="text-sm text-muted-foreground">{t("endsOn", { date: day(addBusinessDays(terms.startDay, days - 1)) })}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-rate" required>
            {t("dayRateLabel")}
          </Label>
          <MoneyInput id="contract-rate" currency="USD" valueMinor={terms.dayRate} onCommit={(v) => set({ dayRate: v })} required className="h-11" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-total">{t("totalLabel")}</Label>
          <MoneyInput
            id="contract-total"
            currency="USD"
            valueMinor={terms.agreedTotal ?? total}
            onCommit={(v) => set({ agreedTotal: v === null || v === total ? null : v })}
            className="h-11"
          />
          {total !== null ? (
            <p className="text-xs text-muted-foreground">{t("computedTotal", { amount: money(total), days: days ?? 0 })}</p>
          ) : null}
        </div>
      </div>
      {totalChanged ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-price-reason" required>
            {t("priceReasonLabel")}
          </Label>
          <Input
            id="contract-price-reason"
            value={terms.priceChangeReason}
            onChange={(e) => set({ priceChangeReason: e.target.value })}
            placeholder={t("priceReasonPlaceholder")}
            maxLength={300}
            required
            className="h-11"
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="contract-driver-rate" required>
          {t("driverDayRateLabel")}
        </Label>
        <MoneyInput
          id="contract-driver-rate"
          currency="USD"
          valueMinor={terms.driverDayRate}
          onCommit={(v) => set({ driverDayRate: v })}
          required
          className="h-11"
        />
        {days !== null && terms.driverDayRate !== null ? (
          <p className="text-xs text-muted-foreground">{t("driverTotal", { amount: money(terms.driverDayRate * days) })}</p>
        ) : null}
      </div>
    </div>
  );
}
