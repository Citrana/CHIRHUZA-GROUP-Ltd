"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { cn } from "@/lib/utils";

/**
 * Submit a payroll entry: who is paid (a person on the platform, or a name),
 * the month, the amount, the location (locked for own-location submitters).
 * It goes to the Chief Admin for approval.
 */
export function NewPayrollDialog({
  service,
  defaultPeriod,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  defaultPeriod: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Payroll");
  const options = useQuery(api.payroll.options, open ? { businessUnitKey: service } : "skip");
  const create = useMutation(api.payroll.create);
  const [mode, setMode] = useState<"person" | "name">("person");
  const [userId, setUserId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [amount, setAmount] = useState<number | null>(null);
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setMode("person");
    setUserId("");
    setWorkerName("");
    setPeriod(defaultPeriod);
    setAmount(null);
    setLocationId("");
    setNote("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if ((mode === "person" ? !userId : !workerName.trim()) || !period || amount === null) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await create({
        businessUnitKey: service,
        ...(mode === "person" ? { userId: userId as Id<"users"> } : { workerName }),
        period,
        amount,
        ...(!options?.locked && locationId ? { locationId: locationId as Id<"locations"> } : {}),
        ...(note.trim() ? { note } : {}),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      const data = e instanceof ConvexError ? e.data : null;
      setError(typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
            <DialogDescription>{t("newHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {t("workerLabel")} <span className="text-destructive">*</span>
              </legend>
              <div role="radiogroup" className="grid grid-cols-2 gap-2">
                {(["person", "name"] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                      mode === m ? "border-primary bg-primary/5" : "border-border",
                    )}
                  >
                    <input type="radio" name="worker-mode" className="size-4 accent-primary" checked={mode === m} onChange={() => setMode(m)} />
                    {t(`workerModes.${m}`)}
                  </label>
                ))}
              </div>
              {mode === "person" ? (
                <NativeSelect aria-label={t("workerLabel")} value={userId} onChange={(e) => setUserId(e.target.value)} required>
                  <option value="" disabled>
                    {t("choosePerson")}
                  </option>
                  {(options?.people ?? []).map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name} ({p.email})
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  aria-label={t("workerLabel")}
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  placeholder={t("workerNamePlaceholder")}
                  maxLength={120}
                  required
                  className="h-11"
                />
              )}
            </fieldset>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="payroll-period" required>
                  {t("periodLabel")}
                </Label>
                <Input id="payroll-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="payroll-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="payroll-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="payroll-location">{t("locationLabel")}</Label>
              {options?.locked ? (
                <p className="flex min-h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm">
                  {options.locations[0]?.name ?? t("noOwnLocation")}
                </p>
              ) : (
                <NativeSelect id="payroll-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t("noLocation")}</option>
                  {(options?.locations ?? []).map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="payroll-note">{t("noteLabel")}</Label>
              <textarea
                id="payroll-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder={t("notePlaceholder")}
                className={TEXTAREA_CLASS}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
