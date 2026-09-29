"use client";

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { useMutation, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import {
  STOCK_BATCH_STATUSES,
  type StockBatchStatus,
} from "../../../convex/lib/stockBatches";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StockBatchStatusBadge } from "@/components/stock/stock-batch-status-badge";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { useCan } from "@/lib/use-can";

type BatchRow = PaginatedQueryItem<typeof api.stockBatches.list>;

function NewBatchDialog({
  service,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("StockBatches");
  const router = useRouter();
  const create = useMutation(api.stockBatches.create);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(false);
    try {
      const id = await create({
        businessUnitKey: service,
        title,
        ...(description.trim() ? { description } : {}),
      });
      onOpenChange(false);
      setTitle("");
      setDescription("");
      router.push(`/${service}/stock/batches/${id}`);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="flex flex-col gap-2">
              <Label htmlFor="batch-title" required>
                {t("titleLabel")}
              </Label>
              <Input
                id="batch-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                maxLength={120}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="batch-description">{t("descriptionLabel")}</Label>
              <textarea
                id="batch-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={1000}
                className={TEXTAREA_CLASS}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t("usdOnly")}</p>
            {error ? <p className="text-sm text-destructive">{t("saveError")}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {t("createBatch")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The service's purchase batches. */
export function StockBatchesPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("StockBatches");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("stock.view");
  const canCreate = useCan("stock.create");
  const [status, setStatus] = useState<StockBatchStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const { results, pagination } = useCursorPaginatedQuery(
    api.stockBatches.list,
    canView ? { businessUnitKey: service, ...(status ? { status } : {}) } : "skip",
  );

  if (canView === undefined) return null;
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const columns: DataTableColumn<BatchRow>[] = [
    {
      id: "number",
      header: t("numberHeader"),
      cell: ({ row }) => row.original.number,
      meta: { className: "whitespace-nowrap font-mono text-xs font-medium" },
    },
    {
      id: "title",
      header: t("titleHeader"),
      cell: ({ row }) => <span className="font-medium">{row.original.title}</span>,
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => <StockBatchStatusBadge status={row.original.status} />,
    },
    {
      id: "lines",
      header: t("linesHeader"),
      cell: ({ row }) => t("lineCount", { count: row.original.lineCount }),
      meta: { hideBelow: "md", className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "total",
      header: t("grandTotalHeader"),
      cell: ({ row }) => formatMoney(row.original.grandTotal, "USD", locale),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => date.format(row.original._creationTime),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canCreate ? (
          <Button onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(b) => b._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        onRowClick={(b) => router.push(`/${service}/stock/batches/${b._id}`)}
        toolbar={
          <NativeSelect
            aria-label={t("statusHeader")}
            className="h-10 w-48 sm:h-8"
            value={status}
            onChange={(e) => setStatus(e.target.value as StockBatchStatus | "")}
          >
            <option value="">{t("allStatuses")}</option>
            {STOCK_BATCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </NativeSelect>
        }
        renderCard={(b) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{b.title}</span>
              <StockBatchStatusBadge status={b.status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {b.number} · {t("lineCount", { count: b.lineCount })} ·{" "}
              {formatMoney(b.grandTotal, "USD", locale)} · {date.format(b._creationTime)}
            </p>
          </div>
        )}
      />
      <NewBatchDialog service={service} open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
