"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { MAX_RANGE_DAYS, daysBetween, weekStart } from "../../../convex/lib/analytics";
import { addBusinessDays, businessDayOf } from "../../../convex/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Which problem a chosen range has (checked again on the server), or null. */
export function rangeProblem(from: string, to: string, today: string): "fromAfterTo" | "inFuture" | "tooLong" | null {
  if (from > to) return "fromAfterTo";
  if (to > today) return "inFuture";
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return "tooLong";
  return null;
}

/** Pick a period (at most 12 months, not in the future); the report is made now and saved. */
export function GenerateReportDialog({
  service,
  open,
  onOpenChange,
  onGenerated,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: (reportId: Id<"reports">) => void;
}) {
  const t = useTranslations("Reports");
  const generate = useMutation(api.reports.generate);
  const [today] = useState(() => businessDayOf(Date.now()));
  // Default: last full week, Monday to Sunday.
  const [from, setFrom] = useState(() => addBusinessDays(weekStart(today), -7));
  const [to, setTo] = useState(() => addBusinessDays(weekStart(today), -1));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = from && to ? rangeProblem(from, to, today) : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setSubmitting(true);
    setError(null);
    try {
      const reportId = await generate({ businessUnitKey: service, from, to });
      onOpenChange(false);
      onGenerated(reportId);
    } catch {
      setError(t("generateError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("generateTitle")}</DialogTitle>
            <DialogDescription>{t("generateHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="report-from" required>
                  {t("fromLabel")}
                </Label>
                <Input id="report-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="report-to" required>
                  {t("toLabel")}
                </Label>
                <Input id="report-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} required className="h-11" />
              </div>
            </div>
            {problem ? (
              <p className="text-sm text-destructive" role="alert">
                {t(problem)}
              </p>
            ) : null}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" className="min-h-11" disabled={submitting || problem !== null}>
              {submitting ? t("generating") : t("generate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
