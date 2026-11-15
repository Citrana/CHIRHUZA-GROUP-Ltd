"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { MAX_CLOSED_NOTE_LENGTH } from "../../../convex/lib/salesDays";
import { MAX_BACKDATE_DAYS } from "../../../convex/lib/sales";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { Link } from "@/i18n/navigation";
import { useSaleDateWindow } from "@/lib/use-sale-date-window";

type SalesDays = FunctionReturnType<typeof api.analytics.getSalesDays>;
type Row = {
  locationId: Id<"locations">;
  name: string;
  day: string;
  canMark: boolean;
  /** Marked "Closed / no sales" (with its note), or still missing. */
  closed: { note: string | null } | null;
};

/**
 * The missing sales days under the sales chart (convex/lib/salesDays.ts):
 * past open days of a shop with no sale. Each one can get its sales added
 * (recent days, through the sale form) or be marked "Closed / no sales";
 * marked days stay listed with an Undo.
 */
export function MissingDaysList({
  service,
  data,
  showShop,
}: {
  service: BusinessUnitKey;
  data: SalesDays | undefined;
  showShop: boolean;
}) {
  const t = useTranslations("Analytics.missingDays");
  const locale = useLocale();
  const clear = useMutation(api.salesDays.clearClosed);
  const [marking, setMarking] = useState<Row | null>(null);
  const [failed, setFailed] = useState(false);
  const longDay = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const dayLabel = (day: string) => longDay.format(Date.parse(`${day}T12:00:00Z`));
  // Sales can be added back to this day: 7 days, or any past day for the Super Admin.
  const { earliest } = useSaleDateWindow();

  const rows: Row[] | undefined = data
    ? [
        ...data.missing.map((m) => ({ ...m, closed: null })),
        ...data.marked.map(({ note, ...m }) => ({ ...m, closed: { note } })),
      ].sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name))
    : undefined;

  async function undo(row: Row) {
    setFailed(false);
    try {
      await clear({ businessUnitKey: service, locationId: row.locationId, day: row.day });
    } catch {
      setFailed(true);
    }
  }

  const status = (row: Row) =>
    row.closed ? (
      <span className="flex flex-col">
        <span className="text-muted-foreground">{t("markedClosed")}</span>
        {row.closed.note ? <span className="text-xs text-muted-foreground">{row.closed.note}</span> : null}
      </span>
    ) : (
      <span className="font-medium text-amber-700 dark:text-amber-400">{t("noSalesRecorded")}</span>
    );

  const actions = (row: Row) => {
    if (row.closed) {
      return row.canMark ? (
        <Button variant="ghost" size="sm" className="min-h-11" onClick={() => undo(row)}>
          {t("undo")}
        </Button>
      ) : null;
    }
    return (
      <span className="flex flex-wrap items-center justify-end gap-1">
        {row.canMark && row.day >= earliest ? (
          <Link
            href={`/${service}/sales/new?date=${row.day}&location=${row.locationId}`}
            className={buttonVariants({ variant: "outline", size: "sm", className: "min-h-11" })}
          >
            {t("addSales")}
          </Link>
        ) : row.canMark ? (
          <span className="text-xs text-muted-foreground">{t("tooOld", { days: MAX_BACKDATE_DAYS })}</span>
        ) : null}
        {row.canMark ? (
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setMarking(row)}>
            {t("markClosed")}
          </Button>
        ) : null}
      </span>
    );
  };

  const columns: DataTableColumn<Row>[] = [
    { id: "day", header: t("dayHeader"), cell: ({ row }) => <span className="font-medium">{dayLabel(row.original.day)}</span> },
    ...(showShop ? [{ id: "shop", header: t("shopHeader"), cell: ({ row }) => row.original.name } satisfies DataTableColumn<Row>] : []),
    { id: "status", header: t("statusHeader"), cell: ({ row }) => status(row.original) },
    { id: "actions", header: () => <span className="sr-only">{t("actionsHeader")}</span>, cell: ({ row }) => actions(row.original) },
  ];

  return (
    <div id="missing-days" className="flex scroll-mt-20 flex-col gap-2">
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => `${r.locationId}-${r.day}`}
        emptyMessage={t("none")}
        pagination={{ mode: "client", pageSize: 10 }}
        renderCard={(row) => (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{dayLabel(row.day)}</span>
              {showShop ? <span className="text-xs text-muted-foreground">{row.name}</span> : null}
            </div>
            {status(row)}
            <div className="flex justify-end">{actions(row)}</div>
          </div>
        )}
      />
      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {t("saveError")}
        </p>
      ) : null}
      <MarkClosedDialog service={service} target={marking} label={marking ? `${dayLabel(marking.day)} · ${marking.name}` : ""} onClose={() => setMarking(null)} />
    </div>
  );
}

/** Mark one day "Closed / no sales", with an optional note. */
function MarkClosedDialog({
  service,
  target,
  label,
  onClose,
}: {
  service: BusinessUnitKey;
  target: Row | null;
  label: string;
  onClose: () => void;
}) {
  const t = useTranslations("Analytics.missingDays");
  const mark = useMutation(api.salesDays.markClosed);
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setNote("");
    setError(false);
    onClose();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    setSubmitting(true);
    setError(false);
    try {
      await mark({ businessUnitKey: service, locationId: target.locationId, day: target.day, ...(note.trim() ? { note } : {}) });
      close();
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("markTitle")}</DialogTitle>
            <DialogDescription>{t("markHint", { day: label })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="closed-day-note">{t("noteLabel")}</Label>
            <textarea
              id="closed-day-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              rows={2}
              maxLength={MAX_CLOSED_NOTE_LENGTH}
              className={TEXTAREA_CLASS}
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {t("saveError")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" className="min-h-11" disabled={submitting}>
              {submitting ? t("saving") : t("markClosed")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
