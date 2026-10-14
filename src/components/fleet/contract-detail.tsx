"use client";

import { useState } from "react";
import { ArrowLeft, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { ContractDates, PaymentBadge } from "@/components/fleet/contract-bits";
import { AddPaymentDialog, DriverPaymentDialog, EditContractDialog, ReasonDialog } from "@/components/fleet/contract-dialogs";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type ContractView = NonNullable<FunctionReturnType<typeof api.contracts.get>>;
type Payment = ContractView["payments"][number];

/**
 * One contract: car, driver, client, dates and money, the client's
 * payments (add one, ask to reverse a wrong one), the driver's payments
 * (each approved by the Chief Admin), and edit / ask to delete.
 */
export function ContractDetail({ service, contractId }: { service: BusinessUnitKey; contractId: Id<"contracts"> }) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const canView = useCan("transport.view");
  const canManage = useCan("transport.contracts.manage");
  const canPayDriver = useCan("transport.driver_pay.request");
  const contract = useQuery(api.contracts.get, canView ? { contractId } : "skip");
  const requestReversal = useMutation(api.contractPayments.requestReversal);
  const requestDelete = useMutation(api.contracts.requestDelete);
  const [today] = useState(() => businessDayOf(Date.now()));
  const [dialog, setDialog] = useState<"pay" | "payDriver" | "edit" | "delete" | { reverse: Payment } | null>(null);

  if (canView === undefined || contract === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  if (contract === null) return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const close = (open: boolean) => !open && setDialog(null);
  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium sm:text-left">{value}</dd>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href={`/${service}/contracts`} className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-2xl font-bold text-primary">
            <span className="font-mono">{contract.number}</span>
          </h1>
          <PaymentBadge contract={contract} />
        </div>
        {contract.deletePending ? <Badge variant="outline" className="self-start">{t("deletePending")}</Badge> : null}
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {row(t("carLabel"), <span className="font-mono">{contract.plateNumber}</span>)}
          {row(t("driverLabel"), contract.driverName ?? "—")}
          {row(t("clientLabel"), [contract.clientName, contract.client?.contactName, contract.client?.phone].filter(Boolean).join(" · "))}
          {row(t("datesHeader"), <ContractDates contract={contract} />)}
          {row(t("dayRateLabel"), money(contract.dayRate))}
          {row(t("totalLabel"), money(contract.totalAmount))}
          {contract.priceChangeReason
            ? row(t("priceReasonLabel"), t("priceChangeShown", { computed: money(contract.computedTotal), reason: contract.priceChangeReason }))
            : null}
          {row(t("paidLabel"), money(contract.amountPaid))}
          {row(t("owesLabel"), <span className={cn(contract.balance > 0 && "text-destructive")}>{money(contract.balance)}</span>)}
          {row(t("driverPayLabel"), t("driverPayShown", { rate: money(contract.driverDayRate), total: money(contract.driverPayTotal) }))}
          {contract.note ? row(t("noteLabel"), contract.note) : null}
        </dl>
        {canManage ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="outline" className="min-h-11" onClick={() => setDialog("edit")}>
              <Pencil aria-hidden />
              {t("edit")}
            </Button>
            {contract.payments.length === 0 && contract.driverPayments.length === 0 && !contract.deletePending ? (
              <Button variant="ghost" className="min-h-11 text-destructive" onClick={() => setDialog("delete")}>
                <Trash2 aria-hidden />
                {t("delete")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-semibold">{t("paymentsTitle")}</h2>
          {canManage && contract.balance > 0 ? (
            <Button className="min-h-11" onClick={() => setDialog("pay")}>
              <Plus aria-hidden />
              {t("addPayment")}
            </Button>
          ) : null}
        </div>
        {contract.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noPayments")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {contract.payments.map((p) => (
              <li key={p._id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block">
                    {[t(`paymentKinds.${p.kind}`), t(`methods.${p.method}`), time.format(p.paidAt)].join(" · ")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {[p.recordedByName, p.note].filter(Boolean).join(" · ")}
                    {p.reversed ? ` · ${t("reversed")}` : p.reversalPending ? ` · ${t("reversalPending")}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={cn("tabular-nums font-medium", (p.amount < 0 || p.reversed) && "text-muted-foreground", p.reversed && "line-through")}>
                    {money(p.amount)}
                  </span>
                  {canManage && p.kind === "payment" && !p.reversed && !p.reversalPending ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8"
                      aria-label={t("reversePayment")}
                      onClick={() => setDialog({ reverse: p })}
                    >
                      <Undo2 aria-hidden />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-heading text-lg font-semibold">{t("driverPaymentsTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("driverPaySummary", {
                paid: money(contract.driverPaid),
                total: money(contract.driverPayTotal),
                owed: money(contract.driverOwed),
              })}
            </p>
          </div>
          {canPayDriver && contract.driverName && contract.driverOwed > 0 ? (
            <Button className="min-h-11" onClick={() => setDialog("payDriver")}>
              <Plus aria-hidden />
              {t("payDriver")}
            </Button>
          ) : null}
        </div>
        {contract.driverPayments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{contract.driverName ? t("noDriverPayments") : t("noDriverOnContract")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card">
            {contract.driverPayments.map((p) => (
              <li key={p._id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block">{[p.driverName, t(`methods.${p.method}`), time.format(p.paidAt)].join(" · ")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[p.requestedByName, p.decidedByName ? t("decidedBy", { name: p.decidedByName }) : null, p.decisionNote, p.note]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn("tabular-nums font-medium", p.status === "rejected" && "text-muted-foreground line-through")}>
                    {money(p.amount)}
                  </span>
                  <ApprovalStatusBadge status={p.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog === "payDriver" ? (
        <DriverPaymentDialog contract={contract} owed={contract.driverOwed} today={today} open onOpenChange={close} />
      ) : null}
      {dialog === "pay" ? <AddPaymentDialog contract={contract} today={today} open onOpenChange={close} /> : null}
      {dialog === "edit" ? <EditContractDialog service={service} contract={contract} open onOpenChange={close} /> : null}
      {dialog === "delete" ? (
        <ReasonDialog
          title={t("deleteTitle", { number: contract.number })}
          description={t("deleteHint")}
          submitLabel={t("requestDelete")}
          open
          onOpenChange={close}
          onSubmit={(reason) => requestDelete({ contractId: contract._id, reason })}
        />
      ) : null}
      {dialog !== null && typeof dialog === "object" ? (
        <ReasonDialog
          title={t("reverseTitle", { amount: money(dialog.reverse.amount) })}
          description={t("reverseHint")}
          submitLabel={t("requestReversal")}
          open
          onOpenChange={close}
          onSubmit={(reason) => requestReversal({ paymentId: dialog.reverse._id, reason })}
        />
      ) : null}
    </div>
  );
}
