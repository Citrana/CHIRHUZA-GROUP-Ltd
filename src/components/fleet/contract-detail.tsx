"use client";

import { useState } from "react";
import { ArrowLeft, Download, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { ContractPaper } from "@/components/fleet/contract-paper";
import { contractPaperContent, renderContractPdf } from "@/lib/contract-pdf";
import { AddPaymentDialog, DriverPaymentDialog, EditContractDialog, ReasonDialog } from "@/components/fleet/contract-dialogs";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type ContractView = NonNullable<FunctionReturnType<typeof api.contracts.get>>;
type Payment = ContractView["payments"][number];

/**
 * One contract, shown as a paper document (the client's copy, also
 * downloadable as a PDF), then the operational parts: the client's
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
  // The moment the page opened (the paper's "issued on", today's date for payments).
  const [openedAt] = useState(() => Date.now());
  const today = businessDayOf(openedAt);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  const [dialog, setDialog] = useState<"pay" | "payDriver" | "edit" | "delete" | { reverse: Payment } | null>(null);

  if (canView === undefined || contract === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  if (contract === null) return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const close = (open: boolean) => !open && setDialog(null);
  const translate = (key: string, values?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], values);
  const paper = contractPaperContent(contract, { t: translate, locale, now: openedAt });

  async function downloadPdf() {
    if (!contract) return;
    setPdfBusy(true);
    setPdfError(false);
    try {
      await renderContractPdf(contractPaperContent(contract, { t: translate, locale, now: Date.now() }), (page, pages) =>
        t("paper.page", { page, pages }),
      );
    } catch {
      setPdfError(true);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6">
      {/* Toolbar: not part of the paper */}
      <div className="flex flex-col gap-3">
        <Link href={`/${service}/contracts`} className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button className="min-h-11" onClick={downloadPdf} disabled={pdfBusy}>
            <Download aria-hidden />
            {pdfBusy ? t("paper.preparing") : t("paper.download")}
          </Button>
          {canManage ? (
            <Button variant="outline" className="min-h-11" onClick={() => setDialog("edit")}>
              <Pencil aria-hidden />
              {t("edit")}
            </Button>
          ) : null}
          {canManage && contract.payments.length === 0 && contract.driverPayments.length === 0 && !contract.deletePending ? (
            <Button variant="ghost" className="min-h-11 text-destructive" onClick={() => setDialog("delete")}>
              <Trash2 aria-hidden />
              {t("delete")}
            </Button>
          ) : null}
          {contract.deletePending ? <Badge variant="outline">{t("deletePending")}</Badge> : null}
        </div>
        {pdfError ? (
          <p className="text-sm text-destructive" role="alert">
            {t("paper.downloadError")}
          </p>
        ) : null}
      </div>

      <ContractPaper content={paper} />

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
