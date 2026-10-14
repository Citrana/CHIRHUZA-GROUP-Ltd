"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { formatMoney } from "../../../convex/lib/money";
import { TRANSPORT_PAYMENT_METHODS, type TransportPaymentMethod } from "../../../convex/lib/transport";
import { ContractTermsFields, termsArgs, termsProblem, type ContractTerms } from "@/components/fleet/contract-terms-fields";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";

/** The message of a ConvexError, or a fallback. */
function errorText(e: unknown, fallback: string): string {
  const data = e instanceof ConvexError ? e.data : null;
  return typeof data === "string" ? data : fallback;
}

/** Money received from the client: amount (up to what's owed), method, date, note. */
export function AddPaymentDialog({
  contract,
  today,
  open,
  onOpenChange,
}: {
  contract: Doc<"contracts">;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const add = useMutation(api.contractPayments.add);
  const owed = contract.totalAmount - contract.amountPaid;
  const [amount, setAmount] = useState<number | null>(owed);
  const [method, setMethod] = useState<TransportPaymentMethod>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!amount || !paidOn) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await add({ contractId: contract._id, amount, method, ...(paidOn !== today ? { paidOn } : {}), ...(note.trim() ? { note } : {}) });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t("saveError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("addPaymentTitle", { number: contract.number })}</DialogTitle>
            <DialogDescription>{t("stillOwed", { amount: formatMoney(owed, "USD", locale) })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="payment-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="payment-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="payment-date" required>
                  {t("paidOnLabel")}
                </Label>
                <Input id="payment-date" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="payment-method" required>
                {t("methodLabel")}
              </Label>
              <NativeSelect id="payment-method" value={method} onChange={(e) => setMethod(e.target.value as TransportPaymentMethod)} className="h-11 w-full">
                {TRANSPORT_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`methods.${m}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="payment-note">{t("noteLabel")}</Label>
              <textarea id="payment-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : t("savePayment")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pays the contract's driver (a part or the rest); the Chief Admin approves. */
export function DriverPaymentDialog({
  contract,
  owed,
  today,
  open,
  onOpenChange,
}: {
  contract: Doc<"contracts">;
  owed: number;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const request = useMutation(api.driverPayments.request);
  const [amount, setAmount] = useState<number | null>(owed);
  const [method, setMethod] = useState<TransportPaymentMethod>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!amount || !paidOn) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await request({ contractId: contract._id, amount, method, ...(paidOn !== today ? { paidOn } : {}), ...(note.trim() ? { note } : {}) });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t("saveError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("payDriverTitle", { name: contract.driverName ?? "" })}</DialogTitle>
            <DialogDescription>{t("payDriverHint", { amount: formatMoney(owed, "USD", locale) })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="driver-pay-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="driver-pay-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="driver-pay-date" required>
                  {t("paidOnLabel")}
                </Label>
                <Input id="driver-pay-date" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="driver-pay-method" required>
                {t("methodLabel")}
              </Label>
              <NativeSelect id="driver-pay-method" value={method} onChange={(e) => setMethod(e.target.value as TransportPaymentMethod)} className="h-11 w-full">
                {TRANSPORT_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`methods.${m}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="driver-pay-note">{t("noteLabel")}</Label>
              <textarea id="driver-pay-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : t("requestDriverPayment")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Asks for something that needs approval (a reversal, a delete), with the reason. */
export function ReasonDialog({
  title,
  description,
  submitLabel,
  open,
  onOpenChange,
  onSubmit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const t = useTranslations("Contracts");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason);
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t("saveError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="approval-reason" required>
              {t("reasonLabel")}
            </Label>
            <textarea id="approval-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} required className={TEXTAREA_CLASS} />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Edits a contract's dates, prices, driver and note, with the reason for the change. */
export function EditContractDialog({
  service,
  contract,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  contract: Doc<"contracts">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Contracts");
  const update = useMutation(api.contracts.update);
  const drivers = useQuery(api.drivers.list, open ? { businessUnitKey: service } : "skip");
  const [terms, setTerms] = useState<ContractTerms>({
    startDay: contract.startDay,
    days: String(contract.days),
    dayRate: contract.dayRate,
    agreedTotal: contract.totalAmount === contract.computedTotal ? null : contract.totalAmount,
    priceChangeReason: contract.priceChangeReason ?? "",
    driverDayRate: contract.driverDayRate,
  });
  const [driverId, setDriverId] = useState<string>(contract.driverId ?? "");
  const [note, setNote] = useState(contract.note ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Active drivers, plus the contract's own (even if inactive now).
  const choices = (drivers ?? []).filter((d) => d.status === "active" || d._id === contract.driverId);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = termsProblem(terms) ?? (reason.trim() ? null : "missingFields");
    if (problem) {
      setError(t(problem));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await update({
        contractId: contract._id,
        ...termsArgs(terms),
        driverId: driverId ? (driverId as Id<"drivers">) : null,
        ...(note.trim() ? { note } : {}),
        reason,
      });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t("saveError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("editTitle", { number: contract.number })}</DialogTitle>
            <DialogDescription>{t("editHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <ContractTermsFields terms={terms} onChange={setTerms} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-driver">{t("driverLabel")}</Label>
              <NativeSelect id="edit-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} className="h-11 w-full">
                <option value="">{t("noDriver")}</option>
                {choices.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-note">{t("noteLabel")}</Label>
              <textarea id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-reason" required>
                {t("editReasonLabel")}
              </Label>
              <Input id="edit-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required className="h-11" />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
