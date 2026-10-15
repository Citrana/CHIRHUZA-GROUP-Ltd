"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { BUSINESS_TIME_ZONE, businessDayOf, businessDayStartUtc } from "../../../convex/lib/time";
import { FilterField } from "@/components/filters/filter-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DATE_PRESETS, dateRangeChip, matchingPreset, presetRange } from "@/lib/date-presets";

export type DateRange = { from: string; to: string };

/** Today's business day (Lubumbashi), fixed for the component's life. */
function useToday(): string {
  const [today] = useState(() => businessDayOf(Date.now()));
  return today;
}

/**
 * Date shortcuts (Today ... Last month) and From / To, for a FilterPanel.
 * A shortcut is highlighted while the dates match it; tapping the
 * highlighted one clears the dates.
 */
export function DateRangeFilter({ id, value, onChange }: { id: string; value: DateRange; onChange: (next: DateRange) => void }) {
  const t = useTranslations("Filters");
  const today = useToday();
  const active = matchingPreset(value.from, value.to, today);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t("presetsLabel")} className="flex flex-wrap gap-2">
        {DATE_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant={active === preset ? "default" : "outline"}
            size="sm"
            className="h-11 rounded-full px-3 sm:h-7"
            aria-pressed={active === preset}
            onClick={() => onChange(active === preset ? { from: "", to: "" } : presetRange(preset, today))}
          >
            {t(`presets.${preset}`)}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FilterField id={`${id}-from`} label={t("fromLabel")}>
          <Input
            id={`${id}-from`}
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="h-11 sm:h-8"
          />
        </FilterField>
        <FilterField id={`${id}-to`} label={t("toLabel")}>
          <Input
            id={`${id}-to`}
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="h-11 sm:h-8"
          />
        </FilterField>
      </div>
    </div>
  );
}

/** The chip text for a date range ("This week", "2 Oct 2026 – 9 Oct 2026", "From …"), or null when unset. */
export function useDateRangeLabel(): (range: DateRange) => string | null {
  const t = useTranslations("Filters");
  const locale = useLocale();
  const today = useToday();
  const day = (d: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: BUSINESS_TIME_ZONE }).format(
      businessDayStartUtc(d),
    );
  return ({ from, to }) => {
    const chip = dateRangeChip(from, to, today);
    if (!chip) return null;
    switch (chip.kind) {
      case "preset":
        return t(`presets.${chip.preset}`);
      case "day":
        return day(chip.day);
      case "range":
        return t("dateRangeChip", { from: day(chip.from), to: day(chip.to) });
      case "from":
        return t("fromChip", { date: day(chip.from) });
      case "to":
        return t("toChip", { date: day(chip.to) });
    }
  };
}
