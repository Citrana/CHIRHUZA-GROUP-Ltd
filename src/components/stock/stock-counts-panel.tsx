"use client";

import { useState, type FormEvent } from "react";
import { BellRing, ClipboardList, MapPin, User, Warehouse } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import type { HolderType } from "../../../convex/lib/inventory";
import { formatMoney } from "../../../convex/lib/money";
import { COUNT_STATUSES, type CountScope, type CountStatus } from "../../../convex/lib/stockCounts";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
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
import { NewStockCountDialog } from "@/components/stock/new-stock-count-dialog";
import { useCan } from "@/lib/use-can";

type CountRow = PaginatedQueryItem<typeof api.stockCounts.list>;

const STATUS_VARIANTS: Record<CountStatus, "outline" | "secondary" | "default" | "ghost"> = {
  counting: "outline",
  review: "secondary",
  submitted: "outline",
  done: "default",
  cancelled: "ghost",
};

export function StockCountStatusBadge({ status }: { status: CountStatus }) {
  const t = useTranslations("StockCounts.statuses");
  return <Badge variant={STATUS_VARIANTS[status]}>{t(status)}</Badge>;
}

/** The counted place or person, with an icon for its kind. */
export function CountHolder({ holder }: { holder: { type: HolderType; name: string } }) {
  const t = useTranslations("Inventory");
  const Icon = holder.type === "user" ? User : holder.type === "location" ? MapPin : Warehouse;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium">{holder.type === "business" ? t("holderTypes.business") : holder.name}</span>
    </span>
  );
}

/** "All products", a category, or "N products picked at random". */
export function useScopeLabel() {
  const t = useTranslations("StockCounts");
  const tCategory = useTranslations("ProductCategories");
  return (scope: CountScope) =>
    scope.kind === "all"
      ? t("scopeAll")
      : scope.kind === "category"
        ? tCategory(scope.category)
        : t("scopeSampleOf", { count: scope.size });
}

/** Lost and gained value of a count's differences, at purchase cost. */
export function LostGained({ lost, gained, locale }: { lost: number; gained: number; locale: string }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 tabular-nums">
      <span className={lost > 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
        −{formatMoney(lost, "USD", locale)}
      </span>
      <span className={gained > 0 ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>
        +{formatMoney(gained, "USD", locale)}
      </span>
    </span>
  );
}

function ReminderDialog({
  service,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("StockCounts");
  const settings = useQuery(api.stockCounts.settings, open ? { businessUnitKey: service } : "skip");
  const save = useMutation(api.stockCounts.setSettings);
  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = days ?? (settings ? String(settings.reminderDays) : "");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError(t("reminderInvalid"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await save({ businessUnitKey: service, reminderDays: n });
      onOpenChange(false);
    } catch {
      setError(t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDays(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("reminderTitle")}</DialogTitle>
            <DialogDescription>{t("reminderHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="reminder-days" required>
              {t("reminderLabel")}
            </Label>
            <Input
              id="reminder-days"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              step={1}
              required
              value={value}
              onChange={(e) => setDays(e.target.value)}
              className="h-10 w-32 sm:h-8"
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || !settings}>
              {saving ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Stock count history, "Start a count" and the reminder setting. */
export function StockCountsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("StockCounts");
  const locale = useLocale();
  const router = useRouter();
  const scopeLabel = useScopeLabel();
  const canView = useCan("stock.view");
  const canRecord = useCan("stock.count.record");
  const canReview = useCan("stock.count.review");
  const canApprove = useCan("stock.count.approve");
  const allowed = canView || canRecord || canReview || canApprove;
  const [status, setStatus] = useState<CountStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const { results, pagination } = useCursorPaginatedQuery(
    api.stockCounts.list,
    allowed ? { businessUnitKey: service, ...(status ? { status } : {}) } : "skip",
  );

  if ([canView, canRecord, canReview, canApprove].some((c) => c === undefined)) return null;
  if (!allowed) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const showResult = (row: CountRow) => row.status === "submitted" || row.status === "done";

  const columns: DataTableColumn<CountRow>[] = [
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => date.format(row.original.snapshotAt),
      meta: { className: "whitespace-nowrap" },
    },
    { id: "holder", header: t("holderHeader"), cell: ({ row }) => <CountHolder holder={row.original.holder} /> },
    {
      id: "scope",
      header: t("scopeHeader"),
      cell: ({ row }) => scopeLabel(row.original.scope),
      meta: { hideBelow: "lg" },
    },
    {
      id: "by",
      header: t("startedByHeader"),
      cell: ({ row }) => row.original.startedByName ?? "—",
      meta: { hideBelow: "lg", className: "text-muted-foreground" },
    },
    {
      id: "differences",
      header: t("differencesHeader"),
      cell: ({ row }) => (showResult(row.original) ? row.original.diffCount : "—"),
      meta: { hideBelow: "sm", align: "right", className: "tabular-nums" },
    },
    {
      id: "value",
      header: t("valueHeader"),
      cell: ({ row }) =>
        showResult(row.original) ? (
          <LostGained lost={row.original.lostCost} gained={row.original.gainedCost} locale={locale} />
        ) : (
          "—"
        ),
      meta: { hideBelow: "sm", className: "whitespace-nowrap" },
    },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => <StockCountStatusBadge status={row.original.status} /> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canApprove ? (
            <Button variant="outline" className="h-11 sm:h-8" onClick={() => setReminderOpen(true)}>
              <BellRing aria-hidden />
              {t("reminder")}
            </Button>
          ) : null}
          {canRecord ? (
            <Button className="h-11 sm:h-8" onClick={() => setNewOpen(true)}>
              <ClipboardList aria-hidden />
              {t("start")}
            </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(c) => c._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        onRowClick={(c) => router.push(`/${service}/stock/counts/${c._id}`)}
        toolbar={
          <NativeSelect
            aria-label={t("statusHeader")}
            className="h-10 w-48 sm:h-8"
            value={status}
            onChange={(e) => setStatus(e.target.value as CountStatus | "")}
          >
            <option value="">{t("allStatuses")}</option>
            {COUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </NativeSelect>
        }
        renderCard={(c) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <CountHolder holder={c.holder} />
              <StockCountStatusBadge status={c.status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {date.format(c.snapshotAt)} · {scopeLabel(c.scope)} · {c.startedByName ?? "—"}
            </p>
            {showResult(c) ? (
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span>{t("differencesCount", { count: c.diffCount })}</span>
                <LostGained lost={c.lostCost} gained={c.gainedCost} locale={locale} />
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t("progress", { counted: c.countedCount, total: c.itemCount })}</p>
            )}
          </div>
        )}
      />
      {canRecord ? (
        <NewStockCountDialog
          service={service}
          open={newOpen}
          onOpenChange={setNewOpen}
          onStarted={(id) => router.push(`/${service}/stock/counts/${id}`)}
        />
      ) : null}
      {canApprove ? <ReminderDialog service={service} open={reminderOpen} onOpenChange={setReminderOpen} /> : null}
    </div>
  );
}
