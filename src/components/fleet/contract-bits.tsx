"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Doc } from "../../../convex/_generated/dataModel";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayStartUtc } from "../../../convex/lib/time";
import { Badge } from "@/components/ui/badge";

/** A business day (YYYY-MM-DD) as "1 Oct 2026" in the user's language. */
export function useDayFormat(): (day: string) => string {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: BUSINESS_TIME_ZONE });
  return (day) => format.format(businessDayStartUtc(day));
}

/** "1 Oct 2026 → 19 Oct 2026 · 19 days". */
export function ContractDates({ contract }: { contract: Pick<Doc<"contracts">, "startDay" | "endDay" | "days"> }) {
  const t = useTranslations("Contracts");
  const day = useDayFormat();
  return <span className="whitespace-nowrap">{t("dates", { start: day(contract.startDay), end: day(contract.endDay), days: contract.days })}</span>;
}

/** "Owes $150.00" or "Paid". */
export function PaymentBadge({ contract }: { contract: Pick<Doc<"contracts">, "totalAmount" | "amountPaid"> }) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const owed = contract.totalAmount - contract.amountPaid;
  return owed > 0 ? (
    <Badge variant="destructive">{t("owes", { amount: formatMoney(owed, "USD", locale) })}</Badge>
  ) : (
    <Badge variant="secondary">{t("paid")}</Badge>
  );
}
