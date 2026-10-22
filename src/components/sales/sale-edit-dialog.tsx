"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Minus, Plus } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { formatMoney } from "../../../convex/lib/money";
import { MAX_BACKDATE_DAYS } from "../../../convex/lib/sales";
import { COLLECTION_METHODS, type CollectionMethod } from "../../../convex/lib/credit";
import { addBusinessDays, businessDayOf } from "../../../convex/lib/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { ProductPhoto } from "@/components/products/product-photo";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { cn } from "@/lib/utils";
import { useProductLineLabel } from "./use-product-line-label";

type EditOptions = NonNullable<FunctionReturnType<typeof api.sales.editOptions>>;
type Line = { saleItemId: Id<"saleItems">; qty: number; price: number | null; reason: string };

/**
 * Asks for a sale to be corrected (sales.requestEdit): quantities, prices,
 * the total, payment method, customer name and date, with a reason.
 * Nothing changes until a sales.edit.approve holder approves it; the
 * server re-checks everything.
 */
export function SaleEditDialog({ saleId, onClose }: { saleId: Id<"sales"> | null; onClose: () => void }) {
  const t = useTranslations("Sales");
  const sale = useQuery(api.sales.editOptions, saleId ? { saleId } : "skip");
  return (
    <Dialog open={saleId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editTitle", { number: sale?.number ?? "" })}</DialogTitle>
          <DialogDescription>{t("editHint")}</DialogDescription>
        </DialogHeader>
        {sale === undefined ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : sale === null ? (
          <p className="text-sm text-muted-foreground">{t("editNotFound")}</p>
        ) : (
          <SaleEditForm key={sale._id} sale={sale} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SaleEditForm({ sale, onClose }: { sale: EditOptions; onClose: () => void }) {
  const t = useTranslations("Sales");
  const tCommon = useTranslations("Common");
  const locale = useLocale();
  const lineLabel = useProductLineLabel();
  const requestEdit = useMutation(api.sales.requestEdit);
  const [lines, setLines] = useState<Line[]>(() =>
    sale.lines.map((l) => ({ saleItemId: l.saleItemId, qty: l.qty, price: l.unitPrice, reason: l.discountReason ?? "" })),
  );
  // The agreed total, for the lines' total it was entered against (as in the sale form).
  const [agreed, setAgreed] = useState<{ value: number; linesTotal: number } | null>(
    sale.totalAmount !== sale.linesTotal ? { value: sale.totalAmount, linesTotal: sale.linesTotal } : null,
  );
  const [saleReason, setSaleReason] = useState(sale.saleDiscountReason ?? "");
  const [payment, setPayment] = useState(sale.paymentMethod);
  const [customer, setCustomer] = useState(sale.customerName ?? "");
  const [soldOn, setSoldOn] = useState(sale.soldOn);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [today] = useState(() => businessDayOf(Date.now()));

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const earliest = addBusinessDays(today, -MAX_BACKDATE_DAYS);
  const linesTotal = lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
  const agreedTotal = agreed && agreed.linesTotal === linesTotal ? agreed.value : null;
  const total = agreedTotal ?? linesTotal;
  const discounted = total < linesTotal;

  if (sale.pendingEdit && !sent) {
    return <p className="text-sm text-muted-foreground">{t("editPending")}</p>;
  }
  if (sent) {
    return (
      <>
        <p role="status" className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
          {t("editSent")}
        </p>
        <DialogFooter>
          <Button type="button" className="min-h-11" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  function update(saleItemId: Id<"saleItems">, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.saleItemId === saleItemId ? { ...l, ...patch } : l)));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await requestEdit({
        saleId: sale._id,
        reason,
        changes: {
          lines: lines.map((l) => ({
            saleItemId: l.saleItemId,
            qty: l.qty,
            unitPrice: l.price ?? 0,
            ...(l.reason.trim() ? { discountReason: l.reason } : {}),
          })),
          ...(agreedTotal !== null && agreedTotal !== linesTotal
            ? { agreedTotal, ...(saleReason.trim() ? { saleDiscountReason: saleReason } : {}) }
            : {}),
          ...(sale.isCredit ? {} : { paymentMethod: payment, customerName: customer }),
          ...(soldOn !== sale.soldOn ? { soldOn } : {}),
        },
      });
      setSent(true);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { message?: string } | string) : null;
      setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("editError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 text-sm">
      <RequiredFieldsHint />
      <ul className="flex flex-col gap-3" aria-label={t("linesLabel")}>
        {sale.lines.map((original) => {
          const line = lines.find((l) => l.saleItemId === original.saleItemId)!;
          const max = original.qty + original.available;
          const differs = original.suggestedPrice !== null && line.price !== null && line.price !== original.suggestedPrice;
          return (
            <li key={original.saleItemId} className={cn("flex flex-col gap-3 rounded-lg border border-border p-3", line.qty === 0 && "opacity-60")}>
              <div className="flex min-w-0 items-center gap-3">
                {original.photoUrl ? <ProductPhoto url={original.photoUrl} size="md" /> : null}
                <div className="min-w-0">
                  <p className="font-medium">{lineLabel(original)}</p>
                  <p className="text-xs text-muted-foreground">
                    {line.qty === 0 ? t("editRemoved") : t("inStock", { count: original.available })}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("qtyLabel")}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-11"
                      aria-label={t("less")}
                      disabled={line.qty <= 0}
                      onClick={() => update(line.saleItemId, { qty: line.qty - 1 })}
                    >
                      <Minus aria-hidden />
                    </Button>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={max}
                      step={1}
                      value={line.qty}
                      aria-label={t("qtyLabel")}
                      onChange={(e) =>
                        update(line.saleItemId, { qty: Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))) })
                      }
                      className="h-11 w-16 text-center"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-11"
                      aria-label={t("more")}
                      disabled={line.qty >= max}
                      onClick={() => update(line.saleItemId, { qty: line.qty + 1 })}
                    >
                      <Plus aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{t("priceLabel")}</span>
                  <MoneyInput
                    currency="USD"
                    valueMinor={line.price}
                    onCommit={(price) => update(line.saleItemId, { price })}
                    aria-label={t("priceLabel")}
                    className="h-11"
                  />
                  {original.suggestedPrice !== null ? (
                    <span className="text-xs text-muted-foreground">{t("suggestedHint", { price: money(original.suggestedPrice) })}</span>
                  ) : null}
                </div>
              </div>
              {differs && line.qty > 0 ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`edit-reason-${line.saleItemId}`} required>
                    {t("discountReasonLabel", { suggested: money(original.suggestedPrice!) })}
                  </Label>
                  <Input
                    id={`edit-reason-${line.saleItemId}`}
                    value={line.reason}
                    onChange={(e) => update(line.saleItemId, { reason: e.target.value })}
                    placeholder={t("discountReasonPlaceholder")}
                    maxLength={300}
                    required
                    className="h-11"
                  />
                </div>
              ) : null}
              <p className="flex justify-between">
                <span className="text-muted-foreground">{t("lineTotal")}</span>
                <span className="font-medium tabular-nums">{money((line.price ?? 0) * line.qty)}</span>
              </p>
            </li>
          );
        })}
      </ul>

      <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={t("totalToPayLabel")}>
        <p className="flex justify-between">
          <span className="text-muted-foreground">{t("linesTotalLabel")}</span>
          <span className="tabular-nums">{money(linesTotal)}</span>
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="edit-total" required>
            {t("totalToPayLabel")}
          </Label>
          <MoneyInput
            id="edit-total"
            currency="USD"
            valueMinor={total}
            onCommit={(value) => setAgreed(value === null || value === linesTotal ? null : { value, linesTotal })}
            aria-invalid={total > linesTotal || undefined}
            className="h-11"
            required
          />
          <span className="text-xs text-muted-foreground">{t("totalToPayHint")}</span>
        </div>
        {discounted ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-discount-reason" required>
              {t("saleDiscountReasonLabel")}
            </Label>
            <Input
              id="edit-discount-reason"
              value={saleReason}
              onChange={(e) => setSaleReason(e.target.value)}
              placeholder={t("saleDiscountReasonPlaceholder")}
              maxLength={300}
              required
              className="h-11"
            />
          </div>
        ) : null}
      </section>

      {sale.isCredit ? (
        <p className="rounded-md bg-muted/40 p-2 text-muted-foreground">{t("editCreditNote")}</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-medium">
              {t("paymentLabel")} <span className="text-destructive">*</span>
            </legend>
            <div role="radiogroup" className="grid grid-cols-2 gap-2">
              {COLLECTION_METHODS.map((method: CollectionMethod) => (
                <label
                  key={method}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-center font-medium",
                    payment === method ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="edit-payment"
                    className="sr-only"
                    checked={payment === method}
                    onChange={() => setPayment(method)}
                  />
                  {t(`payments.${method}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-customer">{t("customerLabel")}</Label>
            <Input
              id="edit-customer"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              maxLength={120}
              placeholder={t("customerOptional")}
              className="h-11"
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-date" required>
          {t("dateLabel")}
        </Label>
        <Input
          id="edit-date"
          type="date"
          value={soldOn}
          min={sale.soldOn < earliest ? sale.soldOn : earliest}
          max={today}
          required
          onChange={(e) => e.target.value && setSoldOn(e.target.value)}
          className="h-11 w-44"
        />
        <p className="text-xs text-muted-foreground">{t("editDateHint", { days: MAX_BACKDATE_DAYS })}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="edit-reason" required>
          {t("editReasonLabel")}
        </Label>
        <textarea
          id="edit-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("editReasonPlaceholder")}
          maxLength={300}
          required
          rows={3}
          className={TEXTAREA_CLASS}
        />
      </div>

      {error ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" disabled={submitting} onClick={onClose}>
          {t("editCancel")}
        </Button>
        <Button type="submit" className="min-h-11" disabled={submitting}>
          {submitting ? t("editSending") : t("editSubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
