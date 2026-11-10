"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
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

/** "Someone else" in the received-by list: type a name instead. */
const OTHER = "__other";

/**
 * Record opening cash: money already held that didn't come from a sale.
 * How much, the day it was received (today or earlier), who received it (a
 * user or a typed name), where it is (locked for own-location users), and a
 * required note. Above the threshold it waits in Approvals.
 */
export function NewOpeningCashDialog({
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
  const t = useTranslations("Cash");
  const locale = useLocale();
  const options = useQuery(api.cash.options, open ? { businessUnitKey: service } : "skip");
  const create = useMutation(api.cash.createOpeningCash);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [receivedBy, setReceivedBy] = useState("");
  const [receivedByName, setReceivedByName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setAmount(null);
    setDate(today);
    setReceivedBy("");
    setReceivedByName("");
    setLocationId("");
    setNote("");
    setError(null);
  }

  const typedName = receivedBy === OTHER;
  const needsApproval = amount !== null && options !== undefined && amount > options.threshold;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (amount === null || !date || !note.trim() || !receivedBy || (typedName && !receivedByName.trim())) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await create({
        businessUnitKey: service,
        amount,
        note,
        ...(date !== today ? { date } : {}),
        ...(typedName ? { receivedByName } : { receivedByUserId: receivedBy as Id<"users"> }),
        ...(!options?.locked && locationId ? { locationId: locationId as Id<"locations"> } : {}),
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
                <Label htmlFor="opening-cash-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="opening-cash-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="opening-cash-date" required>
                  {t("dateLabel")}
                </Label>
                <Input id="opening-cash-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="opening-cash-received-by" required>
                {t("receivedByLabel")}
              </Label>
              <NativeSelect id="opening-cash-received-by" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} required>
                <option value="">{t("choosePerson")}</option>
                {(options?.people ?? []).map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name} ({p.email})
                  </option>
                ))}
                <option value={OTHER}>{t("someoneElse")}</option>
              </NativeSelect>
              {typedName ? (
                <Input
                  aria-label={t("receivedByNameLabel")}
                  placeholder={t("receivedByNameLabel")}
                  value={receivedByName}
                  onChange={(e) => setReceivedByName(e.target.value)}
                  maxLength={100}
                  required
                  className="h-11"
                />
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="opening-cash-location">{t("locationLabel")}</Label>
              {options?.locked ? (
                <p className="flex min-h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm">
                  {options.locations[0]?.name ?? t("noOwnLocation")}
                </p>
              ) : (
                <NativeSelect id="opening-cash-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
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
              <Label htmlFor="opening-cash-note" required>
                {t("noteLabel")}
              </Label>
              <textarea
                id="opening-cash-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("notePlaceholder")}
                rows={3}
                maxLength={500}
                required
                className={TEXTAREA_CLASS}
              />
            </div>
            {needsApproval ? (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                {t("needsApproval", { threshold: formatMoney(options.threshold, "USD", locale) })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("notInProfit")}</p>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" className="min-h-11" disabled={submitting}>
              {submitting ? t("saving") : needsApproval ? t("submitForApproval") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
