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

/**
 * Request a withdrawal: cash taken for no business purpose. Who took it
 * (default: me), when (today or earlier), from which till (locked for
 * own-location requesters), how much and why. The Chief Admin approves.
 */
export function NewWithdrawalDialog({
  service,
  today,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Withdrawals");
  const options = useQuery(api.withdrawals.options, open ? { businessUnitKey: service } : "skip");
  const create = useMutation(api.withdrawals.create);
  const [amount, setAmount] = useState<number | null>(null);
  const [takenBy, setTakenBy] = useState("");
  const [date, setDate] = useState(today);
  const [locationId, setLocationId] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setAmount(null);
    setTakenBy("");
    setDate(today);
    setLocationId("");
    setReason("");
    setNote("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (amount === null || !reason.trim() || !date) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await create({
        businessUnitKey: service,
        amount,
        reason,
        ...(date !== today ? { date } : {}),
        ...(takenBy ? { takenBy: takenBy as Id<"users"> } : {}),
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="withdrawal-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="withdrawal-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="withdrawal-date" required>
                  {t("dateLabel")}
                </Label>
                <Input id="withdrawal-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="withdrawal-taken-by" required>
                {t("takenByLabel")}
              </Label>
              <NativeSelect id="withdrawal-taken-by" value={takenBy} onChange={(e) => setTakenBy(e.target.value)}>
                <option value="">{t("me")}</option>
                {(options?.people ?? []).map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name} ({p.email})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="withdrawal-location">{t("locationLabel")}</Label>
              {options?.locked ? (
                <p className="flex min-h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm">
                  {options.locations[0]?.name ?? t("noOwnLocation")}
                </p>
              ) : (
                <NativeSelect id="withdrawal-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
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
              <Label htmlFor="withdrawal-reason" required>
                {t("reasonLabel")}
              </Label>
              <Input
                id="withdrawal-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reasonPlaceholder")}
                maxLength={300}
                required
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="withdrawal-note">{t("noteLabel")}</Label>
              <textarea id="withdrawal-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={TEXTAREA_CLASS} />
            </div>
            <p className="text-xs text-muted-foreground">{t("notAnExpense")}</p>
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
