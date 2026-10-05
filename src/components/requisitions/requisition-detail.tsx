"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, Download, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductPickerDialog } from "@/components/requisitions/product-picker-dialog";
import { RequisitionStatusBadge } from "@/components/requisitions/requisition-status-badge";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { downloadRequisitionPdf, requisitionPdfContent } from "@/lib/requisition-pdf";

type Detail = NonNullable<FunctionReturnType<typeof api.requisitions.get>>;
type Item = Detail["items"][number];

/** Quantity cell: editable (saved on blur / Enter) while the requisition is editable. */
function QtyEditor({ item }: { item: Item }) {
  const t = useTranslations("Requisitions");
  const updateItem = useMutation(api.requisitions.updateItem);
  const [value, setValue] = useState(String(item.qtyRequested));
  const [shown, setShown] = useState(item.qtyRequested);
  const [error, setError] = useState(false);

  // Follow server changes.
  if (item.qtyRequested !== shown) {
    setShown(item.qtyRequested);
    setValue(String(item.qtyRequested));
  }

  async function save() {
    const qty = Number(value);
    if (qty === item.qtyRequested) return;
    setError(false);
    try {
      await updateItem({ itemId: item._id, qtyRequested: qty, ...(item.note ? { note: item.note } : {}) });
    } catch {
      setError(true);
      setValue(String(item.qtyRequested));
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={value}
        aria-label={t("qtyLabel")}
        aria-invalid={error || undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        className="h-10 w-24 sm:h-8"
      />
      {error ? <span className="text-xs text-destructive">{t("qtyError")}</span> : null}
    </div>
  );
}

export function RequisitionDetail({
  service,
  requisitionId,
}: {
  service: BusinessUnitKey;
  requisitionId: string;
}) {
  const t = useTranslations("Requisitions");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const requisition = useQuery(api.requisitions.get, { requisitionId });
  const removeItem = useMutation(api.requisitions.removeItem);
  const submit = useMutation(api.requisitions.submit);
  const update = useMutation(api.requisitions.update);
  const locations = useQuery(
    api.requisitions.locationOptions,
    requisition?.canEdit ? { businessUnitKey: service } : "skip",
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editLocation, setEditLocation] = useState<Id<"locations"> | "">("");
  const [editNote, setEditNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // The PDF is built in the browser from this page's data (nothing stored).
  const tUnits = useTranslations("BusinessUnits");
  const me = useQuery(api.users.getCurrentUser);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(false);

  const back = (
    <Link
      href={`/${service}/requisitions`}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("backToList")}
    </Link>
  );

  if (requisition === undefined) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (requisition === null || requisition.businessUnitKey !== service) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  }

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const { canEdit } = requisition;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(false);
    try {
      await action();
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit(event: FormEvent) {
    event.preventDefault();
    if (!requisition || !editLocation) return;
    const ok = await run(() =>
      update({
        requisitionId: requisition._id,
        locationId: editLocation,
        ...(editNote.trim() ? { note: editNote } : {}),
      }),
    );
    if (ok) setEditOpen(false);
  }

  const columns: DataTableColumn<Item>[] = [
    {
      id: "product",
      header: t("productHeader"),
      cell: ({ row }) => (
        <div className="min-w-40">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {row.original.productName ?? "—"}
            {row.original.addedByBuyer ? <Badge variant="secondary">{t("addedByBuyer")}</Badge> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              row.original.sku,
              row.original.lengthInches !== null ? tProducts("inches", { inches: row.original.lengthInches }) : null, row.original.sizeName,
              row.original.colourName,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      ),
    },
    {
      id: "qty",
      header: t("qtyHeader"),
      cell: ({ row }) =>
        canEdit ? <QtyEditor item={row.original} /> : <span className="tabular-nums">{row.original.qtyRequested}</span>,
    },
    {
      id: "note",
      header: t("lineNoteHeader"),
      cell: ({ row }) => row.original.note ?? "—",
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "resolution",
      header: t("resolutionHeader"),
      cell: ({ row }) => <Badge variant="outline">{t(`resolutions.${row.original.resolution}`)}</Badge>,
      meta: { hideBelow: "lg" },
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            header: () => <span className="sr-only">{t("actionsHeader")}</span>,
            cell: ({ row }: { row: { original: Item } }) => (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => run(() => removeItem({ itemId: row.original._id }))}
              >
                <Trash2 aria-hidden />
                {t("remove")}
              </Button>
            ),
            meta: { className: "text-right" },
          } satisfies DataTableColumn<Item>,
        ]
      : []),
  ];

  async function downloadPdf() {
    if (!requisition) return;
    setPdfBusy(true);
    setPdfError(false);
    try {
      const content = requisitionPdfContent(requisition, {
        t: (key, values) => t(key as Parameters<typeof t>[0], values),
        locale,
        serviceName: tUnits(service),
        downloadedBy: me?.name || me?.email || "-",
        now: Date.now(),
      });
      await downloadRequisitionPdf(content, (page, pages) => t("pdf.page", { page, pages }));
    } catch {
      setPdfError(true);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {back}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-bold text-primary">{requisition.number}</h1>
            <RequisitionStatusBadge status={requisition.status} />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("locationLabel")}</dt>
            <dd>{requisition.locationName ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("createdByHeader")}</dt>
            <dd>
              {requisition.createdByName ?? "—"} · {time.format(requisition._creationTime)}
            </dd>
            {requisition.submittedAt ? (
              <>
                <dt className="text-muted-foreground">{t("submittedAt")}</dt>
                <dd>{time.format(requisition.submittedAt)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("noteLabel")}</dt>
            <dd className="whitespace-pre-wrap">{requisition.note ?? "—"}</dd>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" disabled={pdfBusy} onClick={downloadPdf}>
            <Download aria-hidden />
            {pdfBusy ? t("pdf.preparing") : t("pdf.download")}
          </Button>
          {canEdit ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setEditLocation(requisition.locationId);
                  setEditNote(requisition.note ?? "");
                  setError(false);
                  setEditOpen(true);
                }}
              >
                <Pencil aria-hidden />
                {t("editDetails")}
              </Button>
              <Button disabled={!requisition.canSubmit || busy} onClick={() => setSubmitOpen(true)}>
                <Send aria-hidden />
                {requisition.status === "rejected" ? t("resubmit") : t("submit")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {pdfError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("pdf.error")}
        </p>
      ) : null}

      {requisition.status === "rejected" && requisition.approval ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="font-medium text-destructive">
            {t("rejectedBy", { name: requisition.approval.decidedByName ?? "—" })}
          </p>
          {requisition.approval.decisionNote ? (
            <p className="mt-1 whitespace-pre-wrap">{requisition.approval.decisionNote}</p>
          ) : null}
          {canEdit ? <p className="mt-2 text-muted-foreground">{t("reviseHint")}</p> : null}
        </div>
      ) : requisition.status === "submitted" ? (
        <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          {t("waitingForApproval")}{" "}
          <Link href={`/${service}/approvals`} className="underline underline-offset-4">
            {t("viewApprovals")}
          </Link>
        </p>
      ) : requisition.status === "approved" ? (
        <p className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
          {t("approvedNote", { name: requisition.approval?.decidedByName ?? "—" })}
        </p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-semibold">
            {t("itemsTitle")} ({requisition.items.length})
          </h2>
          {canEdit ? (
            <Button variant="outline" onClick={() => setPickerOpen(true)}>
              <Plus aria-hidden />
              {t("addProduct")}
            </Button>
          ) : null}
        </div>
        <DataTable
          columns={columns}
          data={requisition.items}
          getRowId={(item) => item._id}
          emptyMessage={canEdit ? t("noItemsEditable") : requisition.note ? t("emptyForBuyer") : t("noItems")}
        />
      </section>

      {canEdit ? (
        <ProductPickerDialog
          service={service}
          requisitionId={requisition._id}
          existingProductIds={new Set(requisition.items.map((i) => i.productId))}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      ) : null}

      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("submitTitle", { number: requisition.number })}</DialogTitle>
            <DialogDescription>
              {requisition.isOpen ? t("submitEmptyDescription") : t("submitDescription")}
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => submit({ requisitionId: requisition._id }));
                if (ok) setSubmitOpen(false);
              }}
            >
              <Send aria-hidden />
              {t("confirmSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>{t("editDetails")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-location" required>
                  {t("locationLabel")}
                </Label>
                <NativeSelect
                  id="edit-location"
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value as Id<"locations">)}
                  required
                >
                  {locations?.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-note">{t("noteLabel")}</Label>
                <textarea
                  id="edit-note"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                  className={TEXTAREA_CLASS}
                />
              </div>
              {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !editLocation}>
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
