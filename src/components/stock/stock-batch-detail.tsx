"use client";

import { useState } from "react";
import {
  ArrowLeft,
  Lock,
  PackageCheck,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Truck,
} from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddExtraProductDialog } from "@/components/stock/add-extra-product-dialog";
import { AddRequisitionLinesDialog } from "@/components/stock/add-requisition-lines-dialog";
import {
  BatchItemProduct,
  ItemCostField,
  ItemQtyField,
  ItemReasonField,
  ItemStatusField,
  RemoveItemButton,
  type BatchDetail,
  type BatchItem,
} from "@/components/stock/batch-item-editor";
import { ExpenseDialog } from "@/components/stock/expense-dialog";
import { ReceivingSection } from "@/components/stock/receiving-section";
import { StockBatchStatusBadge } from "@/components/stock/stock-batch-status-badge";
import { RequisitionStatusBadge } from "@/components/requisitions/requisition-status-badge";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";

type Expense = BatchDetail["expenses"][number];

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={strong ? "text-lg font-semibold tabular-nums" : "tabular-nums"}>{value}</p>
    </div>
  );
}

/** Title / description, autosaved on blur while draft. */
function DraftHeaderFields({ batch }: { batch: BatchDetail }) {
  const t = useTranslations("StockBatches");
  const update = useMutation(api.stockBatches.update);
  const [title, setTitle] = useState(batch.title);
  const [description, setDescription] = useState(batch.description ?? "");
  const [error, setError] = useState(false);

  async function save(next: Partial<{ title: string; description: string }>) {
    setError(false);
    const merged = {
      title: next.title ?? batch.title,
      description: next.description ?? batch.description ?? "",
    };
    try {
      await update({
        batchId: batch._id,
        title: merged.title,
        ...(merged.description.trim() ? { description: merged.description } : {}),
      });
    } catch {
      setError(true);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="batch-title-edit" required>
          {t("titleLabel")}
        </Label>
        <Input
          id="batch-title-edit"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== batch.title && save({ title })}
          maxLength={120}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="batch-description-edit">{t("descriptionLabel")}</Label>
        <textarea
          id="batch-description-edit"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== (batch.description ?? "") && save({ description })}
          rows={2}
          maxLength={1000}
          className={TEXTAREA_CLASS}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {error ? <span className="text-destructive">{t("saveError")}</span> : t("autosaveHint")}
      </p>
    </div>
  );
}

export function StockBatchDetail({ service, batchId }: { service: BusinessUnitKey; batchId: string }) {
  const t = useTranslations("StockBatches");
  const locale = useLocale();
  const batch = useQuery(api.stockBatches.get, { batchId });
  const markPurchased = useMutation(api.stockBatches.markPurchased);
  const submitForApproval = useMutation(api.stockBatches.submitForApproval);
  const requestReopen = useMutation(api.stockBatches.requestReopen);
  const markShipped = useMutation(api.stockBatches.markShipped);
  const markArrived = useMutation(api.stockBatches.markArrived);
  const removeExpense = useMutation(api.stockBatches.removeExpense);

  const [linesOpen, setLinesOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  // Opening "Add product" for a given requisition (e.g. an empty one).
  const [extraFor, setExtraFor] = useState<Id<"requisitions"> | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Doc<"stockBatchExpenses"> | undefined>();
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const back = (
    <Link
      href={`/${service}/stock/batches`}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("backToList")}
    </Link>
  );

  if (batch === undefined) return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  if (batch === null || batch.businessUnitKey !== service) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  }

  const money = (minor: number | undefined | null) =>
    minor === undefined || minor === null ? "—" : formatMoney(minor, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const draft = batch.status === "draft";
  const editing = batch.canEdit;
  // Expenses stay open after purchase (transport paid on arrival, etc.).
  const editingExpenses = batch.canEditExpenses;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; lines?: unknown[] }) : null;
      setError(
        data?.code === "INCOMPLETE"
          ? t("incomplete", { count: data.lines?.length ?? 0 })
          : t("actionError"),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  const incompleteCount = batch.items.filter((i) => i.problems.length > 0).length;
  const purchasedItems = batch.items.filter((i) => i.status === "purchased");
  const notPurchasedItems = batch.items.filter((i) => i.status === "not_purchased");

  // ---- draft: editable lines
  const draftColumns: DataTableColumn<BatchItem>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <BatchItemProduct item={row.original} /> },
    { id: "status", header: t("lineStatusHeader"), cell: ({ row }) => <ItemStatusField item={row.original} /> },
    {
      id: "requested",
      header: t("requestedHeader"),
      cell: ({ row }) => (row.original.requisitionNumber ? row.original.qtyRequested : "—"),
      meta: { hideBelow: "lg", className: "tabular-nums text-muted-foreground" },
    },
    { id: "qty", header: t("purchasedQtyHeader"), cell: ({ row }) => <ItemQtyField item={row.original} /> },
    {
      id: "cost",
      header: t("unitCostHeader"),
      cell: ({ row }) => <ItemCostField item={row.original} canSetPrice={batch.canSetPrice} />,
    },
    { id: "reason", header: t("reasonHeader"), cell: ({ row }) => <ItemReasonField item={row.original} /> },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) => <RemoveItemButton item={row.original} />,
      meta: { className: "text-right" },
    },
  ];

  // ---- after purchase: the Goma view
  const purchasedColumns: DataTableColumn<BatchItem>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <BatchItemProduct item={row.original} /> },
    {
      id: "qty",
      header: t("purchasedQtyHeader"),
      cell: ({ row }) =>
        row.original.requisitionNumber
          ? t("qtyOfRequested", { purchased: row.original.qtyPurchased, requested: row.original.qtyRequested })
          : row.original.qtyPurchased,
      meta: { className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "unitCost",
      header: t("unitCostHeader"),
      cell: ({ row }) => money(row.original.unitCost),
      meta: { className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "lineTotal",
      header: t("lineTotalHeader"),
      cell: ({ row }) =>
        money(row.original.unitCost !== undefined ? row.original.unitCost * row.original.qtyPurchased : undefined),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums font-medium" },
    },
    {
      id: "reason",
      header: t("reasonHeader"),
      cell: ({ row }) => row.original.reason ?? "—",
      meta: { hideBelow: "lg", className: "text-muted-foreground" },
    },
  ];
  const notPurchasedColumns: DataTableColumn<BatchItem>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <BatchItemProduct item={row.original} /> },
    {
      id: "requested",
      header: t("requestedHeader"),
      cell: ({ row }) => row.original.qtyRequested,
      meta: { className: "tabular-nums" },
    },
    { id: "reason", header: t("reasonHeader"), cell: ({ row }) => row.original.reason ?? "—" },
  ];

  const expenseColumns: DataTableColumn<Expense>[] = [
    {
      id: "category",
      header: t("categoryHeader"),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{t(`categories.${row.original.category}`)}</p>
          {row.original.note ? <p className="text-xs text-muted-foreground">{row.original.note}</p> : null}
        </div>
      ),
    },
    {
      id: "amount",
      header: t("amountHeader"),
      cell: ({ row }) => money(row.original.amount),
      meta: { className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "receipt",
      header: t("receiptHeader"),
      cell: ({ row }) =>
        row.original.receiptUrl ? (
          <a
            href={row.original.receiptUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
          >
            <Paperclip className="size-4" aria-hidden />
            {t("viewReceipt")}
          </a>
        ) : (
          "—"
        ),
      meta: { hideBelow: "sm" },
    },
    ...(editingExpenses
      ? [
          {
            id: "actions",
            header: () => <span className="sr-only">{t("actionsHeader")}</span>,
            cell: ({ row }: { row: { original: Expense } }) => (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingExpense(row.original);
                    setExpenseOpen(true);
                  }}
                >
                  <Pencil aria-hidden />
                  {t("edit")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => run(() => removeExpense({ expenseId: row.original._id }))}
                >
                  <Trash2 aria-hidden />
                  {t("remove")}
                </Button>
              </div>
            ),
            meta: { className: "text-right" },
          } satisfies DataTableColumn<Expense>,
        ]
      : []),
  ];

  const pending = batch.approval?.status === "pending" ? batch.approval : null;
  const lastRejected =
    draft && batch.approval?.status === "rejected" && batch.approval.kind === "approve" ? batch.approval : null;

  return (
    <div className="flex flex-col gap-6">
      {back}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-bold text-primary">{batch.title}</h1>
            <StockBatchStatusBadge status={batch.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {batch.number} · USD · {batch.createdByName ?? "—"}
          </p>
          {!draft && batch.description ? <p className="mt-1 whitespace-pre-wrap text-sm">{batch.description}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <Button disabled={busy} onClick={() => setPurchaseOpen(true)}>
              <Lock aria-hidden />
              {t("markPurchased")}
            </Button>
          ) : null}
          {batch.canSubmit ? (
            <Button disabled={busy} onClick={() => run(() => submitForApproval({ batchId: batch._id }))}>
              <Send aria-hidden />
              {t("submitForApproval")}
            </Button>
          ) : null}
          {batch.canRequestReopen ? (
            <Button variant="outline" disabled={busy} onClick={() => setReopenOpen(true)}>
              <RotateCcw aria-hidden />
              {t("requestReopen")}
            </Button>
          ) : null}
          {batch.canShip ? (
            <Button disabled={busy} onClick={() => run(() => markShipped({ batchId: batch._id }))}>
              <Truck aria-hidden />
              {t("markShipped")}
            </Button>
          ) : null}
          {batch.canMarkArrived ? (
            <Button disabled={busy} onClick={() => run(() => markArrived({ batchId: batch._id }))}>
              <PackageCheck aria-hidden />
              {t("markArrived")}
            </Button>
          ) : null}
        </div>
      </div>

      {pending ? (
        <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          {pending.kind === "reopen" ? t("pendingReopen") : t("pendingApproval")}{" "}
          <Link href={`/${service}/approvals`} className="underline underline-offset-4">
            {t("viewApprovals")}
          </Link>
        </p>
      ) : null}
      {lastRejected ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-medium text-destructive">{t("rejectedBy", { name: lastRejected.decidedByName ?? "—" })}</p>
          {lastRejected.decisionNote ? <p className="mt-1 whitespace-pre-wrap">{lastRejected.decisionNote}</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

      {editing ? <DraftHeaderFields key={batch._id} batch={batch} /> : null}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={t("totalsTitle")}>
        <Stat label={t("purchasedTotal")} value={money(batch.totals.purchasedTotal)} />
        <Stat label={t("expensesTotal")} value={money(batch.totals.expensesTotal)} />
        <div className="col-span-2 sm:col-span-1">
          <Stat label={t("grandTotal")} value={money(batch.totals.grandTotal)} strong />
        </div>
      </section>
      {draft ? <p className="-mt-3 text-xs text-muted-foreground">{t("totalsPreviewHint")}</p> : null}

      {draft ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-semibold">
              {t("linesTitle")} ({batch.items.length})
            </h2>
            {editing ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setLinesOpen(true)}>
                  <Plus aria-hidden />
                  {t("addFromRequisitions")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setExtraFor(null);
                    setExtraOpen(true);
                  }}
                >
                  <Plus aria-hidden />
                  {t("addExtra")}
                </Button>
              </div>
            ) : null}
          </div>
          {incompleteCount > 0 && editing ? (
            <p className="text-sm text-muted-foreground">{t("linesToResolve", { count: incompleteCount })}</p>
          ) : null}
          <DataTable
            columns={editing ? draftColumns : purchasedColumns}
            data={batch.items}
            getRowId={(i) => i._id}
            emptyMessage={t("noLines")}
            renderCard={
              editing
                ? (item) => (
                    <div className="flex flex-col gap-3">
                      <BatchItemProduct item={item} />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                          <ItemStatusField item={item} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            {item.requisitionNumber
                              ? t("qtyRequestedShort", { qty: item.qtyRequested })
                              : t("purchasedQtyHeader")}
                          </span>
                          <ItemQtyField item={item} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">{t("unitCostHeader")}</span>
                          <ItemCostField item={item} canSetPrice={batch.canSetPrice} />
                        </div>
                        <div className="col-span-2">
                          <ItemReasonField item={item} />
                        </div>
                      </div>
                      <div>
                        <RemoveItemButton item={item} />
                      </div>
                    </div>
                  )
                : undefined
            }
          />
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-lg font-semibold">
              {t("purchasedTitle")} ({purchasedItems.length})
            </h2>
            <DataTable columns={purchasedColumns} data={purchasedItems} getRowId={(i) => i._id} emptyMessage={t("noLines")} />
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-lg font-semibold">
              {t("notPurchasedTitle")} ({notPurchasedItems.length})
            </h2>
            <p className="-mt-2 text-xs text-muted-foreground">{t("notPurchasedHint")}</p>
            <DataTable
              columns={notPurchasedColumns}
              data={notPurchasedItems}
              getRowId={(i) => i._id}
              emptyMessage={t("noneNotPurchased")}
            />
          </section>
          <ReceivingSection service={service} batch={batch} />
        </>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-semibold">
            {t("expensesTitle")} ({batch.expenses.length})
          </h2>
          {editingExpenses ? (
            <Button
              variant="outline"
              onClick={() => {
                setEditingExpense(undefined);
                setExpenseOpen(true);
              }}
            >
              <Plus aria-hidden />
              {t("addExpense")}
            </Button>
          ) : null}
        </div>
        <p className="-mt-1 text-xs text-muted-foreground">{t("expensesHint")}</p>
        <DataTable
          columns={expenseColumns}
          data={batch.expenses}
          getRowId={(e) => e._id}
          emptyMessage={t("noExpenses")}
        />
      </section>

      {batch.requisitions.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-semibold">{t("requisitionsTitle")}</h2>
          <ul className="flex flex-col gap-2">
            {batch.requisitions.map((r) => (
              <li key={r._id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/${service}/requisitions/${r._id}`} className="font-mono text-primary underline-offset-4 hover:underline">
                  {r.number}
                </Link>
                <span className="text-muted-foreground">{r.locationName ?? "—"}</span>
                {r.status ? <RequisitionStatusBadge status={r.status} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!draft ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-semibold">{t("timelineTitle")}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {(["purchasedAt", "approvedAt", "shippedAt", "arrivedAt", "receivedAt"] as const).map((key) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{t(`timeline.${key}`)}</dt>
                <dd>{batch[key] ? time.format(batch[key]) : "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {editing ? (
        <>
          <AddRequisitionLinesDialog
            service={service}
            batchId={batch._id}
            open={linesOpen}
            onOpenChange={setLinesOpen}
            onAddProducts={(requisitionId) => {
              setLinesOpen(false);
              setExtraFor(requisitionId);
              setExtraOpen(true);
            }}
          />
          <AddExtraProductDialog
            service={service}
            batchId={batch._id}
            canSetPrice={batch.canSetPrice}
            requisitionId={extraFor}
            open={extraOpen}
            onOpenChange={setExtraOpen}
          />
        </>
      ) : null}
      {editingExpenses ? (
        <ExpenseDialog batchId={batch._id} expense={editingExpense} open={expenseOpen} onOpenChange={setExpenseOpen} />
      ) : null}

      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("markPurchasedTitle")}</DialogTitle>
            <DialogDescription>{t("markPurchasedDescription")}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt>{t("purchasedTotal")}</dt>
            <dd className="tabular-nums">{money(batch.totals.purchasedTotal)}</dd>
            <dt>{t("expensesTotal")}</dt>
            <dd className="tabular-nums">{money(batch.totals.expensesTotal)}</dd>
            <dt className="font-medium">{t("grandTotal")}</dt>
            <dd className="font-medium tabular-nums">{money(batch.totals.grandTotal)}</dd>
          </dl>
          {incompleteCount > 0 ? (
            <p className="text-sm text-destructive">{t("incomplete", { count: incompleteCount })}</p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              disabled={busy || incompleteCount > 0 || batch.items.length === 0}
              onClick={async () => {
                if (await run(() => markPurchased({ batchId: batch._id }))) setPurchaseOpen(false);
              }}
            >
              <Lock aria-hidden />
              {t("confirmMarkPurchased")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("requestReopen")}</DialogTitle>
            <DialogDescription>{t("requestReopenDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reopen-reason" required>
              {t("reasonLabel")}
            </Label>
            <textarea
              id="reopen-reason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              rows={3}
              maxLength={500}
              required
              className={TEXTAREA_CLASS}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              disabled={busy || !reopenReason.trim()}
              onClick={async () => {
                if (await run(() => requestReopen({ batchId: batch._id, reason: reopenReason }))) {
                  setReopenOpen(false);
                  setReopenReason("");
                }
              }}
            >
              <RotateCcw aria-hidden />
              {t("sendReopenRequest")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
