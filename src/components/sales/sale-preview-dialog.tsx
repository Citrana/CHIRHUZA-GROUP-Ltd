"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductPhoto } from "@/components/products/product-photo";

export type SalePreviewLine = {
  key: number;
  label: string;
  photoUrl?: string | null;
  qtyAtPrice: string;
  total: string;
  reason: string | null;
};

export type SalePreview = {
  date: string;
  backdated: boolean;
  location: string;
  lines: SalePreviewLine[];
  linesTotal: string;
  total: string;
  // Set when the agreed total is lower than the lines' total.
  saleDiscountReason: string | null;
  payment: string;
  customer: string | null;
  credit: { paidNow: string; paidWith: string | null; balance: string } | null;
};

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <p className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "text-right text-base font-semibold tabular-nums" : "text-right font-medium tabular-nums"}>
        {children}
      </span>
    </p>
  );
}

/**
 * The last look at a sale before it is recorded: the seller confirms it,
 * or goes back to the form (everything kept) to correct it. Only shows
 * what the form prepared - the form records the sale.
 */
export function SalePreviewDialog({
  open,
  preview,
  withPhotos,
  submitting,
  blocker,
  error,
  onCorrect,
  onConfirm,
}: {
  open: boolean;
  preview: SalePreview;
  withPhotos: boolean;
  submitting: boolean;
  // Live data changed while open (e.g. stock sold elsewhere): can't confirm.
  blocker: string | null;
  error: string | null;
  onCorrect: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Sales");
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !submitting ? onCorrect() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>{t("reviewTitle")}</DialogTitle>
          <DialogDescription>{t("reviewHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Row label={t("dateLabel")}>{preview.date}</Row>
          {preview.backdated ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              {t("pastDateNote", { date: preview.date })}
            </p>
          ) : null}
          <Row label={t("locationLabel")}>{preview.location}</Row>
        </div>

        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={t("linesLabel")}>
          {preview.lines.map((line) => (
            <li key={line.key} className="flex items-start gap-3 p-3">
              {withPhotos ? <ProductPhoto url={line.photoUrl} size="md" /> : null}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{line.label}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{line.qtyAtPrice}</p>
                {line.reason ? (
                  <p className="text-xs text-muted-foreground">{t("discountReasonShown", { reason: line.reason })}</p>
                ) : null}
              </div>
              <span className="shrink-0 font-medium tabular-nums">{line.total}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2">
          {preview.saleDiscountReason ? (
            <>
              <Row label={t("linesTotalLabel")}>{preview.linesTotal}</Row>
              <Row label={t("saleDiscountReasonLabel")}>{preview.saleDiscountReason}</Row>
            </>
          ) : null}
          <Row label={t("totalToPayLabel")} strong>
            {preview.total}
          </Row>
          <Row label={t("paymentLabel")}>{preview.payment}</Row>
          <Row label={t("customerLabel")}>{preview.customer ?? t("reviewNoCustomer")}</Row>
          {preview.credit ? (
            <>
              <Row label={t("paidNowLabel")}>
                {preview.credit.paidNow}
                {preview.credit.paidWith ? ` · ${preview.credit.paidWith}` : null}
              </Row>
              <Row label={t("balanceLabel")} strong>
                {preview.credit.balance}
              </Row>
            </>
          ) : null}
        </div>

        {blocker || error ? (
          <p className="text-destructive" role="alert">
            {blocker ?? error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" className="min-h-11" disabled={submitting} onClick={onCorrect}>
            {t("reviewCorrect")}
          </Button>
          <Button type="button" className="min-h-11" disabled={submitting || !!blocker} onClick={onConfirm}>
            {submitting ? t("recording") : t("reviewConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
