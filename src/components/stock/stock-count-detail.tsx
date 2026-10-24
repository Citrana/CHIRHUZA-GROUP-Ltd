"use client";

import { useState } from "react";
import { ArrowLeft, Check, Eye, EyeOff, ListFilter, RotateCcw } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { notFound } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { COUNT_REASONS, type CountReason } from "../../../convex/lib/stockCounts";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import {
  CountHolder,
  StockCountStatusBadge,
  useScopeLabel,
} from "@/components/stock/stock-counts-panel";
import { cn } from "@/lib/utils";

type Count = NonNullable<FunctionReturnType<typeof api.stockCounts.get>>;
type Line = Count["lines"][number];

/** Red for missing units, amber for extra ones, plain when it matches. */
function diffClass(difference: number | null) {
  if (!difference) return "text-muted-foreground";
  return difference < 0 ? "font-medium text-destructive" : "font-medium text-amber-700 dark:text-amber-400";
}

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n);
}

function ProductCell({ line }: { line: Line }) {
  const tProducts = useTranslations("Products");
  return (
    <span className="block min-w-0">
      <span className="block font-medium">{line.productName ?? "—"}</span>
      <span className="block text-xs text-muted-foreground">
        {[
          line.sku,
          line.lengthInches !== null ? tProducts("inches", { inches: line.lengthInches }) : null,
          line.sizeName,
          line.colourName,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </span>
  );
}

/** A whole-number count that saves on blur / Enter when its value changed. */
function CountInput({ line, label }: { line: Line; label: string }) {
  const saveCount = useMutation(api.stockCounts.saveCount);
  const [error, setError] = useState(false);
  const current = line.countedQty;
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [shown, setShown] = useState(current);
  if (current !== shown) {
    setShown(current);
    setValue(current === null ? "" : String(current));
  }
  const commit = async () => {
    if (value.trim() === "") return;
    const qty = Number(value);
    if (!Number.isInteger(qty) || qty < 0) {
      setError(true);
      return;
    }
    if (qty === current) return;
    setError(false);
    try {
      await saveCount({ itemId: line._id, countedQty: qty });
    } catch {
      setError(true);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        aria-label={label}
        aria-invalid={error || undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        className="h-11 w-24 text-base sm:h-8 sm:w-20 sm:text-sm"
      />
      {current !== null && !error ? <Check className="size-4 text-[color:var(--chart-2)]" aria-hidden /> : null}
    </span>
  );
}

function ReasonFields({ line, missing, readOnly }: { line: Line; missing: boolean; readOnly: boolean }) {
  const t = useTranslations("StockCounts");
  const setReason = useMutation(api.stockCounts.setReason);
  const [note, setNote] = useState(line.note ?? "");
  const [shownNote, setShownNote] = useState(line.note);
  if (line.note !== shownNote) {
    setShownNote(line.note);
    setNote(line.note ?? "");
  }
  if (readOnly) {
    return (
      <span className="block text-sm">
        {line.reason ? t(`reasons.${line.reason}`) : "—"}
        {line.note ? <span className="block text-xs whitespace-pre-wrap text-muted-foreground">{line.note}</span> : null}
      </span>
    );
  }
  const save = (reason: CountReason, nextNote: string) =>
    void setReason({ itemId: line._id, reason, ...(nextNote.trim() ? { note: nextNote } : {}) });
  return (
    <span className="flex min-w-44 flex-col gap-1.5">
      <NativeSelect
        aria-label={t("reasonLabel")}
        aria-invalid={missing || undefined}
        value={line.reason ?? ""}
        onChange={(e) => save(e.target.value as CountReason, note)}
        className={cn("h-10 sm:h-8", missing && "border-destructive")}
      >
        <option value="" disabled>
          {t("chooseReason")}
        </option>
        {COUNT_REASONS.map((r) => (
          <option key={r} value={r}>
            {t(`reasons.${r}`)}
          </option>
        ))}
      </NativeSelect>
      {line.reason ? (
        <Input
          value={note}
          placeholder={t("notePlaceholder")}
          aria-label={t("noteLabel")}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note.trim() !== (line.note ?? "")) save(line.reason!, note);
          }}
          className="h-10 sm:h-8"
        />
      ) : null}
    </span>
  );
}

/**
 * One stock count. Counting: a blind list with a number per product
 * (autosaved; leave and come back any time). Review: expected vs counted,
 * the value of each difference at purchase cost, a reason per difference,
 * recount, and "Send for approval". Afterwards: the result, line by line.
 */
export function StockCountDetail({ service, countId }: { service: BusinessUnitKey; countId: string }) {
  const t = useTranslations("StockCounts");
  const locale = useLocale();
  const scopeLabel = useScopeLabel();
  const [showExpected, setShowExpected] = useState(false);
  const [diffOnly, setDiffOnly] = useState(false);
  const [missingReasons, setMissingReasons] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"finish" | "submit" | "cancel" | null>(null);
  const count = useQuery(api.stockCounts.get, { countId, ...(showExpected ? { showExpected } : {}) });
  const finishCounting = useMutation(api.stockCounts.finishCounting);
  const submit = useMutation(api.stockCounts.submit);
  const cancel = useMutation(api.stockCounts.cancel);
  const recount = useMutation(api.stockCounts.recount);

  const back = (
    <Link
      href={`/${service}/stock/counts`}
      className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("backToCounts")}
    </Link>
  );
  if (count === undefined) return back;
  if (count === null || count.businessUnitKey !== service) notFound();

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const counting = count.status === "counting";
  const review = count.status === "review";
  const closed = !counting && !review;
  const differing = count.lines.filter((l) => l.difference !== null && l.difference !== 0);
  const rows = diffOnly && !counting ? differing : count.lines;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirm(null);
      return true;
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; itemIds?: string[] }) : null;
      if (data?.code === "MISSING_REASONS") {
        setMissingReasons(new Set(data.itemIds ?? []));
        setDiffOnly(true);
        setError(t("missingReasons"));
      } else if (data?.code === "NOTHING_COUNTED") {
        setError(t("nothingCounted"));
      } else {
        setError(t("saveError"));
      }
      setConfirm(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const productColumn: DataTableColumn<Line> = {
    id: "product",
    accessorFn: (l) => [l.productName, l.sku, l.sizeName, l.colourName, l.lengthInches].filter(Boolean).join(" "),
    header: t("productHeader"),
    cell: ({ row }) => <ProductCell line={row.original} />,
  };
  const countedColumn: DataTableColumn<Line> = {
    id: "counted",
    header: t("countedHeader"),
    cell: ({ row }) =>
      closed ? (
        <span className="tabular-nums">{row.original.countedQty ?? "—"}</span>
      ) : (
        <CountInput line={row.original} label={t("countFor", { product: row.original.productName ?? "—" })} />
      ),
  };
  const expectedColumn: DataTableColumn<Line> = {
    id: "expected",
    header: t("expectedHeader"),
    cell: ({ row }) => <span className="tabular-nums">{row.original.expectedQty ?? "—"}</span>,
    meta: { align: "right" },
  };

  const columns: DataTableColumn<Line>[] = counting
    ? [productColumn, ...(count.blind ? [] : [expectedColumn]), countedColumn]
    : [
        productColumn,
        expectedColumn,
        {
          id: "moved",
          header: t("movedHeader"),
          cell: ({ row }) => (
            <span className="text-muted-foreground tabular-nums">
              {row.original.movedSinceSnapshot ? signed(row.original.movedSinceSnapshot) : "—"}
            </span>
          ),
          meta: { hideBelow: "lg", align: "right" },
        },
        countedColumn,
        {
          id: "difference",
          header: t("differenceHeader"),
          cell: ({ row }) => (
            <span className={cn("tabular-nums", diffClass(row.original.difference))}>
              {row.original.difference === null ? "—" : signed(row.original.difference)}
            </span>
          ),
          meta: { align: "right" },
        },
        {
          id: "value",
          header: t("valueAtCostHeader"),
          cell: ({ row }) => (
            <span className={cn("whitespace-nowrap tabular-nums", diffClass(row.original.difference))}>
              {row.original.differenceCost ? money(row.original.differenceCost) : "—"}
            </span>
          ),
          meta: { hideBelow: "sm", align: "right" },
        },
        {
          id: "reason",
          header: t("reasonLabel"),
          cell: ({ row }) =>
            row.original.difference ? (
              <ReasonFields
                line={row.original}
                missing={missingReasons.has(row.original._id) && !row.original.reason}
                readOnly={!review || !count.can.review}
              />
            ) : null,
        },
        closed
          ? {
              id: "decision",
              header: t("decisionHeader"),
              cell: ({ row }) =>
                row.original.adjustmentStatus ? (
                  <ApprovalStatusBadge status={row.original.adjustmentStatus} />
                ) : row.original.countedQty !== null && !row.original.difference ? (
                  <span className="text-xs text-muted-foreground">{t("matches")}</span>
                ) : null,
            }
          : {
              id: "actions",
              header: () => <span className="sr-only">{t("actionsHeader")}</span>,
              cell: ({ row }) =>
                count.can.review && row.original.countedQty !== null ? (
                  <Button
                    variant="outline"
                    className="h-10 sm:h-8"
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(() => recount({ itemId: row.original._id }));
                    }}
                  >
                    <RotateCcw aria-hidden />
                    {t("recount")}
                  </Button>
                ) : null,
              meta: { className: "text-right" },
            },
      ];

  const card = (l: Line) => (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <ProductCell line={l} />
        {closed && l.adjustmentStatus ? <ApprovalStatusBadge status={l.adjustmentStatus} /> : null}
      </div>
      {counting ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {count.blind ? t("countedHeader") : t("expectedValue", { qty: l.expectedQty ?? 0 })}
          </span>
          <CountInput line={l} label={t("countFor", { product: l.productName ?? "—" })} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <span>
              <span className="block text-xs text-muted-foreground">{t("expectedHeader")}</span>
              <span className="tabular-nums">{l.expectedQty ?? "—"}</span>
              {l.movedSinceSnapshot ? (
                <span className="block text-xs text-muted-foreground">
                  {t("movedShort", { qty: signed(l.movedSinceSnapshot) })}
                </span>
              ) : null}
            </span>
            <span>
              <span className="block text-xs text-muted-foreground">{t("countedHeader")}</span>
              {closed ? (
                <span className="tabular-nums">{l.countedQty ?? "—"}</span>
              ) : (
                <CountInput line={l} label={t("countFor", { product: l.productName ?? "—" })} />
              )}
            </span>
            <span>
              <span className="block text-xs text-muted-foreground">{t("differenceHeader")}</span>
              <span className={cn("tabular-nums", diffClass(l.difference))}>
                {l.difference === null ? "—" : signed(l.difference)}
              </span>
              {l.differenceCost ? (
                <span className={cn("block text-xs tabular-nums", diffClass(l.difference))}>{money(l.differenceCost)}</span>
              ) : null}
            </span>
          </div>
          {l.difference ? (
            <ReasonFields
              line={l}
              missing={missingReasons.has(l._id) && !l.reason}
              readOnly={!review || !count.can.review}
            />
          ) : null}
          {review && count.can.review && l.countedQty !== null ? (
            <Button variant="outline" className="h-11 self-start" onClick={() => void run(() => recount({ itemId: l._id }))}>
              <RotateCcw aria-hidden />
              {t("recount")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );

  const percent = count.itemCount ? Math.round((count.countedCount / count.itemCount) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-bold text-primary">{t("countTitle", { number: count.number })}</h1>
          <StockCountStatusBadge status={count.status} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <CountHolder holder={count.holder} />
          <span>· {scopeLabel(count.scope)}</span>
          <span>· {t("startedOn", { date: date.format(count.snapshotAt), name: count.startedByName ?? "—" })}</span>
        </p>
        <p className="text-sm text-muted-foreground">{t(`statusHints.${count.status}`)}</p>
      </div>

      {counting ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{t("progress", { counted: count.countedCount, total: count.itemCount })}</span>
            {count.can.approve ? (
              <Button
                variant="outline"
                className="h-10 sm:h-8"
                aria-pressed={showExpected}
                onClick={() => setShowExpected((v) => !v)}
              >
                {showExpected ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {showExpected ? t("hideExpected") : t("showExpected")}
              </Button>
            ) : null}
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={count.itemCount}
            aria-valuenow={count.countedCount}
            aria-label={t("progress", { counted: count.countedCount, total: count.itemCount })}
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : count.totals ? (
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t("countedSummary")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {t("progress", { counted: count.countedCount, total: count.itemCount })}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("differencesHeader")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{count.totals.diffCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("lostValue")}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", count.totals.lostCost > 0 && "text-destructive")}>
              {money(count.totals.lostCost)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("gainedValue")}</dt>
            <dd
              className={cn(
                "text-lg font-semibold tabular-nums",
                count.totals.gainedCost > 0 && "text-amber-700 dark:text-amber-400",
              )}
            >
              {money(count.totals.gainedCost)}
            </dd>
          </div>
        </dl>
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(l) => l._id}
        emptyMessage={diffOnly ? t("noDifferences") : t("noLines")}
        search={{ placeholder: t("searchPlaceholder") }}
        pagination={{ mode: "client", pageSize: 50 }}
        toolbar={
          counting ? null : (
            <Button
              variant="outline"
              className="h-10 sm:h-8"
              aria-pressed={diffOnly}
              onClick={() => setDiffOnly((v) => !v)}
            >
              <ListFilter aria-hidden />
              {diffOnly ? t("showAll") : t("differencesOnly")}
            </Button>
          )
        }
        renderCard={card}
      />

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {count.status === "submitted" ? (
        <p className="text-sm text-muted-foreground">
          {t("pendingHint")}{" "}
          <Link href={`/${service}/approvals`} className="underline underline-offset-4">
            {t("viewApprovals")}
          </Link>
        </p>
      ) : null}

      {!closed ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {count.can.review ? (
            <Button variant="outline" className="h-11 sm:h-8" disabled={busy} onClick={() => setConfirm("cancel")}>
              {t("cancelCount")}
            </Button>
          ) : null}
          {counting && count.can.record ? (
            <Button className="h-11 sm:h-8" disabled={busy || count.countedCount === 0} onClick={() => setConfirm("finish")}>
              {t("finishCounting")}
            </Button>
          ) : null}
          {review && count.can.review ? (
            <Button className="h-11 sm:h-8" disabled={busy} onClick={() => setConfirm("submit")}>
              {differing.length > 0 ? t("sendForApproval") : t("closeCount")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm === "finish"
                ? t("finishTitle")
                : confirm === "cancel"
                  ? t("cancelTitle")
                  : differing.length > 0
                    ? t("submitTitle")
                    : t("closeTitle")}
            </DialogTitle>
            <DialogDescription>
              {confirm === "finish"
                ? count.countedCount < count.itemCount
                  ? t("finishUncounted", { count: count.itemCount - count.countedCount })
                  : t("finishHint")
                : confirm === "cancel"
                  ? t("cancelHint")
                  : differing.length > 0
                    ? t("submitHint", { count: differing.length })
                    : t("closeHint")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="h-11 sm:h-8" onClick={() => setConfirm(null)}>
              {t("back")}
            </Button>
            <Button
              className="h-11 sm:h-8"
              variant={confirm === "cancel" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => {
                const id = count._id as Id<"stockCounts">;
                void run(() =>
                  confirm === "finish"
                    ? finishCounting({ countId: id })
                    : confirm === "cancel"
                      ? cancel({ countId: id })
                      : submit({ countId: id }),
                );
              }}
            >
              {confirm === "finish"
                ? t("finishCounting")
                : confirm === "cancel"
                  ? t("cancelCount")
                  : differing.length > 0
                    ? t("sendForApproval")
                    : t("closeCount")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
