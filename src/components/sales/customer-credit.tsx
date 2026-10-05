"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { COLLECTION_METHODS, type CollectionMethod } from "../../../convex/lib/credit";
import { formatMoney } from "../../../convex/lib/money";
import { MAX_BACKDATE_DAYS } from "../../../convex/lib/sales";
import { BUSINESS_TIME_ZONE, addBusinessDays, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type View = FunctionReturnType<typeof api.credit.customer>;
type SaleRow = View["sales"][number];
type PaymentRow = View["payments"][number];

function errorMessage(e: unknown, fallback: string): string {
  const data = e instanceof ConvexError ? (e.data as { message?: string } | string) : null;
  return typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : fallback;
}

/**
 * One customer's credit (sales.view): what they owe, their credit sales
 * and payments. Sellers record a payment (split over the oldest open sales
 * first) or report a wrong payment for correction (approval).
 */
export function CustomerCredit({ service, customerId }: { service: BusinessUnitKey; customerId: string }) {
  const t = useTranslations("Credit");
  const tSales = useTranslations("Sales");
  const locale = useLocale();
  const canView = useCan("sales.view");
  const view = useQuery(api.credit.customer, canView ? { customerId: customerId as Id<"customers"> } : "skip");
  const record = useMutation(api.credit.recordRepayment);
  const requestReversal = useMutation(api.credit.requestPaymentReversal);

  const [today] = useState(() => businessDayOf(Date.now()));
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<CollectionMethod>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [correcting, setCorrecting] = useState<Id<"salePayments"> | null>(null);
  const [reason, setReason] = useState("");

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  if (view === undefined) return <p className="text-sm text-muted-foreground">{tSales("loading")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const earliest = addBusinessDays(today, -MAX_BACKDATE_DAYS);

  async function submitPayment(event: FormEvent) {
    event.preventDefault();
    if (!amount || amount <= 0) {
      setMessage({ ok: false, text: t("needAmount") });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await record({
        customerId: customerId as Id<"customers">,
        amount,
        method,
        ...(paidOn !== today ? { paidOn } : {}),
        ...(note.trim() ? { note } : {}),
      });
      setMessage({ ok: true, text: t("recorded", { sales: result.sales.join(", ") }) });
      setAmount(null);
      setNote("");
      setPaidOn(today);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; owed?: number }) : null;
      setMessage({
        ok: false,
        text: data?.code === "OVERPAYMENT" ? t("tooMuch", { owed: money(data.owed ?? 0) }) : errorMessage(e, t("saveError")),
      });
    } finally {
      setSaving(false);
    }
  }

  async function submitCorrection(paymentId: Id<"salePayments">) {
    setSaving(true);
    setMessage(null);
    try {
      await requestReversal({ paymentId, reason });
      setMessage({ ok: true, text: t("correctionSent") });
      setCorrecting(null);
      setReason("");
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e, t("saveError")) });
    } finally {
      setSaving(false);
    }
  }

  const statusBadge = (s: SaleRow) =>
    s.creditStatus === "open" ? (
      <Badge variant="destructive">{t("statusOpen")}</Badge>
    ) : (
      <Badge variant="secondary">{t("statusSettled")}</Badge>
    );

  const saleColumns: DataTableColumn<SaleRow>[] = [
    { id: "number", header: t("saleHeader"), cell: ({ row }) => row.original.number, meta: { className: "font-mono text-xs font-medium" } },
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => day.format(row.original.createdAt),
      meta: { hideBelow: "sm", className: "whitespace-nowrap text-muted-foreground" },
    },
    { id: "location", header: tSales("locationHeader"), cell: ({ row }) => row.original.locationName ?? "—", meta: { hideBelow: "lg" } },
    { id: "total", header: t("totalHeader"), cell: ({ row }) => money(row.original.totalAmount), meta: { hideBelow: "md", className: "tabular-nums" } },
    { id: "paid", header: t("paidHeader"), cell: ({ row }) => money(row.original.amountPaid), meta: { hideBelow: "md", className: "tabular-nums" } },
    {
      id: "balance",
      header: t("balanceHeader"),
      cell: ({ row }) => money(row.original.balance),
      meta: { className: "tabular-nums font-medium" },
    },
    { id: "status", header: "", cell: ({ row }) => statusBadge(row.original) },
  ];

  const canCorrect = (p: PaymentRow) => view.canRequestReversal && p.kind !== "reversal" && !p.reversed && !p.reversalPending;
  const paymentState = (p: PaymentRow) =>
    p.reversed ? (
      <Badge variant="outline">{t("reversed")}</Badge>
    ) : p.reversalPending ? (
      <Badge variant="outline">{t("reversalPending")}</Badge>
    ) : null;
  const paymentColumns: DataTableColumn<PaymentRow>[] = [
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => day.format(row.original.paidAt),
      meta: { className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "kind",
      header: t("saleHeader"),
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <span>
            {[row.original.saleNumber, tSales(`paymentKinds.${row.original.kind}`), tSales(`payments.${row.original.method}`)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {row.original.recordedByName ? (
            <span className="text-xs text-muted-foreground">{t("recordedBy", { name: row.original.recordedByName })}</span>
          ) : null}
          {row.original.note ? <span className="text-xs text-muted-foreground">{row.original.note}</span> : null}
          {paymentState(row.original)}
        </span>
      ),
    },
    {
      id: "amount",
      header: t("amountLabel"),
      cell: ({ row }) => (
        <span className={cn("tabular-nums font-medium", row.original.amount < 0 && "text-destructive")}>{money(row.original.amount)}</span>
      ),
      meta: { className: "whitespace-nowrap" },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("requestCorrection")}</span>,
      cell: ({ row }) =>
        canCorrect(row.original) ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-10" onClick={() => setCorrecting(row.original._id)}>
            {t("requestCorrection")}
          </Button>
        ) : null,
      meta: { className: "text-right" },
    },
  ];

  const correctingPayment = view.payments.find((p) => p._id === correcting);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/${service}/sales/credit`}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("backToList")}
      </Link>
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{view.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {[view.phone, t("owes", { amount: money(view.balance) })].filter(Boolean).join(" · ")}
        </p>
      </div>

      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={cn(
            "flex items-center gap-2 rounded-md border p-3 text-sm",
            message.ok ? "border-primary/30 bg-primary/5" : "border-destructive/30 bg-destructive/5 text-destructive",
          )}
        >
          {message.ok ? <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden /> : null}
          {message.text}
        </p>
      ) : null}

      {view.canRecordPayment && view.balance > 0 ? (
        <form onSubmit={submitPayment} className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <div>
            <h2 className="font-heading text-base font-semibold">{t("recordTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("oldestFirst")}</p>
            <RequiredFieldsHint />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="repay-amount" required>
                {t("amountLabel")}
              </Label>
              <MoneyInput id="repay-amount" currency="USD" valueMinor={amount} onCommit={setAmount} className="h-11" required />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="repay-date" required>
                {t("dateLabel")}
              </Label>
              <Input
                id="repay-date"
                type="date"
                value={paidOn}
                min={earliest}
                max={today}
                required
                onChange={(e) => {
                  const d = e.target.value;
                  if (d >= earliest && d <= today) setPaidOn(d);
                }}
                className="h-11"
              />
              <span className="text-xs text-muted-foreground">{t("dateHint", { days: MAX_BACKDATE_DAYS })}</span>
            </div>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">
              {t("methodLabel")} <span className="text-destructive">*</span>
            </legend>
            <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:max-w-sm">
              {COLLECTION_METHODS.map((m) => (
                <label
                  key={m}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-sm font-medium",
                    method === m ? "border-primary bg-primary text-primary-foreground" : "border-border",
                  )}
                >
                  <input type="radio" name="repay-method" className="sr-only" checked={method === m} onChange={() => setMethod(m)} />
                  {tSales(`payments.${m}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1">
            <Label htmlFor="repay-note">{t("noteLabel")}</Label>
            <Input id="repay-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="h-11" />
          </div>
          <Button type="submit" size="lg" className="min-h-12 self-start" disabled={saving}>
            {saving ? t("recording") : t("recordButton")}
          </Button>
        </form>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-base font-semibold">{t("salesTitle")}</h2>
        <DataTable
          columns={saleColumns}
          data={view.sales}
          getRowId={(s) => s._id}
          emptyMessage={t("noSales")}
          renderCard={(s) => (
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-mono text-xs font-medium">{s.number}</span>
                <span className="block text-xs text-muted-foreground">
                  {day.format(s.createdAt)} · {t("totalHeader")} {money(s.totalAmount)} · {t("paidHeader")} {money(s.amountPaid)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-semibold tabular-nums">{money(s.balance)}</span>
                {statusBadge(s)}
              </span>
            </div>
          )}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-heading text-base font-semibold">{t("paymentsTitle")}</h2>
        {correctingPayment ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <p className="text-sm">
              {[correctingPayment.saleNumber, day.format(correctingPayment.paidAt), money(correctingPayment.amount)].filter(Boolean).join(" · ")}
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="correction-reason" required>
                {t("correctionReason")}
              </Label>
              <Input
                id="correction-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                required
                className="h-11"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                className="min-h-11"
                disabled={saving || !reason.trim()}
                onClick={() => submitCorrection(correctingPayment._id)}
              >
                {t("sendCorrection")}
              </Button>
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setCorrecting(null)}>
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : null}
        <DataTable
          columns={paymentColumns}
          data={view.payments}
          getRowId={(p) => p._id}
          emptyMessage={t("noPayments")}
          renderCard={(p) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">
                  {[p.saleNumber, tSales(`paymentKinds.${p.kind}`), tSales(`payments.${p.method}`)].filter(Boolean).join(" · ")}
                </span>
                <span className={cn("shrink-0 font-semibold tabular-nums", p.amount < 0 && "text-destructive")}>{money(p.amount)}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {[day.format(p.paidAt), p.recordedByName ? t("recordedBy", { name: p.recordedByName }) : null, p.note]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {paymentState(p)}
              {canCorrect(p) ? (
                <Button type="button" variant="outline" size="sm" className="min-h-10 self-start" onClick={() => setCorrecting(p._id)}>
                  {t("requestCorrection")}
                </Button>
              ) : null}
            </div>
          )}
        />
      </section>
    </div>
  );
}
