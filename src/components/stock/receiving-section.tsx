"use client";

import { useState } from "react";
import { PackageCheck } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BatchItemProduct, type BatchDetail, type BatchItem } from "@/components/stock/batch-item-editor";
import { cn } from "@/lib/utils";

type Count = { qtyReceived: number; qtyDamaged: number; reason?: string };

/** Saves one field of a line's count (autosave), keeping the others. */
function useSaveCount(item: BatchItem) {
  const setReceiveCount = useMutation(api.stockBatches.setReceiveCount);
  const [error, setError] = useState(false);
  async function save(patch: Partial<Count>) {
    setError(false);
    try {
      await setReceiveCount({
        itemId: item._id,
        qtyReceived: item.qtyReceived ?? 0,
        qtyDamaged: item.qtyDamaged ?? 0,
        ...(item.receiveReason ? { reason: item.receiveReason } : {}),
        ...patch,
      });
    } catch {
      setError(true);
    }
  }
  return { save, error };
}

/** A whole-number input that saves on blur / Enter when its value changed. */
function CountInput({
  item,
  field,
  label,
}: {
  item: BatchItem;
  field: "qtyReceived" | "qtyDamaged";
  label: string;
}) {
  const { save, error } = useSaveCount(item);
  const current = item[field];
  const [value, setValue] = useState(current === undefined ? "" : String(current));
  const [shown, setShown] = useState(current);
  if (current !== shown) {
    setShown(current);
    setValue(current === undefined ? "" : String(current));
  }
  const commit = () => {
    if (value.trim() === "") return;
    const qty = Number(value);
    if (qty !== current) void save({ [field]: qty });
  };
  const invalid =
    error ||
    item.receiveProblems.includes("over") ||
    (field === "qtyReceived" && item.receiveProblems.includes("count"));
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={0}
      max={item.qtyPurchased}
      step={1}
      value={value}
      placeholder={field === "qtyDamaged" ? "0" : undefined}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      className="h-10 w-20 sm:h-8"
    />
  );
}

function ReasonInput({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const { save, error } = useSaveCount(item);
  const [value, setValue] = useState(item.receiveReason ?? "");
  const [shown, setShown] = useState(item.receiveReason);
  if (item.receiveReason !== shown) {
    setShown(item.receiveReason);
    setValue(item.receiveReason ?? "");
  }
  const needed = item.receiveProblems.includes("reason");
  const commit = () => {
    if (value.trim() !== (item.receiveReason ?? "")) void save({ reason: value });
  };
  return (
    <Input
      value={value}
      placeholder={needed ? t("receiveReasonRequired") : t("reasonOptional")}
      aria-label={t("receiveReasonLabel")}
      aria-invalid={error || needed || undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      maxLength={500}
      className={cn("h-10 min-w-44 sm:h-8", needed && "border-destructive")}
    />
  );
}

/**
 * Goma receiving. While the batch is "arrived", whoever holds stock.receive
 * counts each purchased line (good / damaged; missing is the rest) and
 * confirms: good units become sellable stock with the business. Once
 * received, the count is shown read-only.
 */
export function ReceivingSection({ service, batch }: { service: BusinessUnitKey; batch: BatchDetail }) {
  const t = useTranslations("StockBatches");
  const confirmReceipt = useMutation(api.stockBatches.confirmReceipt);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = batch.items.filter((i) => i.status === "purchased");
  const counting = batch.canReceive;
  const received = batch.status === "received";
  if (!counting && !received) {
    return batch.status === "arrived" ? (
      <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{t("waitingForCount")}</p>
    ) : null;
  }

  const toFix = lines.filter((i) => i.receiveProblems.length > 0).length;
  const sum = (pick: (i: BatchItem) => number) => lines.reduce((s, i) => s + pick(i), 0);
  const totals = {
    purchased: sum((i) => i.qtyPurchased),
    received: sum((i) => i.qtyReceived ?? 0),
    damaged: sum((i) => i.qtyDamaged ?? 0),
    missing: sum((i) => (i.qtyReceived === undefined ? 0 : i.missing)),
  };

  const columns: DataTableColumn<BatchItem>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <BatchItemProduct item={row.original} /> },
    {
      id: "purchased",
      header: t("purchasedQtyHeader"),
      cell: ({ row }) => row.original.qtyPurchased,
      meta: { className: "tabular-nums" },
    },
    {
      id: "received",
      header: t("receivedHeader"),
      cell: ({ row }) =>
        counting ? (
          <CountInput item={row.original} field="qtyReceived" label={t("receivedHeader")} />
        ) : (
          (row.original.qtyReceived ?? 0)
        ),
      meta: { className: "tabular-nums font-medium" },
    },
    {
      id: "damaged",
      header: t("damagedHeader"),
      cell: ({ row }) =>
        counting ? (
          <CountInput item={row.original} field="qtyDamaged" label={t("damagedHeader")} />
        ) : (
          (row.original.qtyDamaged ?? 0)
        ),
      meta: { className: "tabular-nums" },
    },
    {
      id: "missing",
      header: t("missingHeader"),
      cell: ({ row }) => {
        const counted = row.original.qtyReceived !== undefined;
        const missing = row.original.missing;
        return (
          <span className={cn(counted && missing !== 0 && "font-medium text-destructive")}>
            {counted ? missing : "—"}
          </span>
        );
      },
      meta: { className: "tabular-nums" },
    },
    {
      id: "reason",
      header: t("reasonHeader"),
      cell: ({ row }) => (counting ? <ReasonInput item={row.original} /> : (row.original.receiveReason ?? "—")),
      meta: counting ? undefined : { className: "text-muted-foreground" },
    },
  ];

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await confirmReceipt({ batchId: batch._id });
      setConfirmOpen(false);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; lines?: unknown[] }) : null;
      setError(data?.code === "INCOMPLETE" ? t("receiveIncomplete", { count: data.lines?.length ?? 0 }) : t("actionError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold">
          {received ? t("receivedTitle") : t("receivingTitle")}
        </h2>
        {counting ? (
          <Button disabled={busy} onClick={() => setConfirmOpen(true)}>
            <PackageCheck aria-hidden />
            {t("confirmReceipt")}
          </Button>
        ) : (
          <Link href={`/${service}/stock`} className="text-sm text-primary underline-offset-4 hover:underline">
            {t("viewStock")}
          </Link>
        )}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        {received
          ? t("receivedSummary", { ...totals, name: batch.receivedByName ?? "—" })
          : t("receivingHint")}
      </p>
      {counting && toFix > 0 ? (
        <p className="text-sm text-muted-foreground">{t("linesToCount", { count: toFix })}</p>
      ) : null}
      <DataTable
        columns={columns}
        data={lines}
        getRowId={(i) => i._id}
        emptyMessage={t("noLines")}
        renderCard={
          counting
            ? (item) => (
                <div className="flex flex-col gap-3">
                  <BatchItemProduct item={item} />
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t("receivedOf", { qty: item.qtyPurchased })}
                      </span>
                      <CountInput item={item} field="qtyReceived" label={t("receivedHeader")} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{t("damagedHeader")}</span>
                      <CountInput item={item} field="qtyDamaged" label={t("damagedHeader")} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{t("missingHeader")}</span>
                      <span
                        className={cn(
                          "flex h-10 items-center tabular-nums",
                          item.qtyReceived !== undefined && item.missing !== 0 && "font-medium text-destructive",
                        )}
                      >
                        {item.qtyReceived !== undefined ? item.missing : "—"}
                      </span>
                    </div>
                    <div className="col-span-3">
                      <ReasonInput item={item} />
                    </div>
                  </div>
                </div>
              )
            : undefined
        }
      />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmReceiptTitle")}</DialogTitle>
            <DialogDescription>{t("confirmReceiptDescription")}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt>{t("purchasedQtyHeader")}</dt>
            <dd className="tabular-nums">{totals.purchased}</dd>
            <dt className="font-medium">{t("receivedHeader")}</dt>
            <dd className="font-medium tabular-nums">{totals.received}</dd>
            <dt>{t("damagedHeader")}</dt>
            <dd className="tabular-nums">{totals.damaged}</dd>
            <dt>{t("missingHeader")}</dt>
            <dd className="tabular-nums">{totals.missing}</dd>
          </dl>
          {toFix > 0 ? <p className="text-sm text-destructive">{t("receiveIncomplete", { count: toFix })}</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={busy || toFix > 0} onClick={handleConfirm}>
              <PackageCheck aria-hidden />
              {t("confirmReceipt")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
