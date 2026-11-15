"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, Plus, SearchCheck, X } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { daysBetween } from "../../../convex/lib/analytics";
import { DEFAULT_CHECK_DAYS, MAX_CHECK_PRODUCTS, MAX_CHECK_RANGE_DAYS } from "../../../convex/lib/salesCheck";
import { BUSINESS_TIME_ZONE, addBusinessDays, businessDayOf, businessDayStartUtc } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { ProductSearchList, type ProductSearchResult } from "@/components/products/product-search-list";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { useCan } from "@/lib/use-can";
import { useProductLineLabel } from "./use-product-line-label";
import { SaleEditDialog } from "./sale-edit-dialog";
import { DaySheet } from "./sales-check-day";

type CheckResult = FunctionReturnType<typeof api.salesCheck.find>;
export type CheckRow = CheckResult["results"][number];
export type CheckProduct = CheckResult["products"][number];
/** A product on the list: its label, and the quantity typed (may be empty). */
export type ListedItem = { productId: Id<"products">; label: string; qty: string };

type CheckArgs = {
  businessUnitKey: BusinessUnitKey;
  from: string;
  to: string;
  locationId?: Id<"locations">;
  items: Array<{ productId: Id<"products">; qty?: number }>;
};

/** A typed quantity: a whole number from 1, nothing (blank), or wrong. */
function parseQty(value: string): number | undefined | null {
  const text = value.trim();
  if (!text) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Check sales (salesCheck.find, sales.view): enter products (exact
 * variant), optional quantities and a period; see the shop-days that sold
 * them all (fewest other products first), or the closest ones. Opening a
 * day shows its sales next to the list; a sale's date is fixed with the
 * existing "Request correction".
 */
export function SalesCheckPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("SalesCheck");
  const tSales = useTranslations("Sales");
  const locale = useLocale();
  const lineLabel = useProductLineLabel();
  const canView = useCan("sales.view");
  const canPick = useCan("products.view");
  const [today] = useState(() => businessDayOf(Date.now()));
  const [items, setItems] = useState<ListedItem[]>([]);
  const [from, setFrom] = useState(() => addBusinessDays(today, -(DEFAULT_CHECK_DAYS - 1)));
  const [to, setTo] = useState(today);
  const [locationId, setLocationId] = useState("");
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ args: CheckArgs; items: ListedItem[] } | null>(null);
  const [openDay, setOpenDay] = useState<CheckRow | null>(null);
  const [editing, setEditing] = useState<Id<"sales"> | null>(null);
  const filters = useQuery(api.sales.filterLocations, canView ? { businessUnitKey: service } : "skip");
  const result = useQuery(api.salesCheck.find, canView && checked ? checked.args : "skip");

  if (canView === undefined) return null;

  const back = (
    <Link href={`/${service}/sales`} className={buttonVariants({ variant: "ghost", className: "min-h-11 self-start" })}>
      <ArrowLeft aria-hidden />
      {tSales("backToList")}
    </Link>
  );
  if (!canView) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{tSales("accessDenied")}</p>
      </div>
    );
  }

  const dayLabel = (day: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: BUSINESS_TIME_ZONE }).format(
      businessDayStartUtc(day),
    );
  const products = new Map((result?.products ?? []).map((p) => [p.productId, p]));
  const labelOf = (productId: Id<"products">) => {
    const p = products.get(productId);
    return p ? lineLabel(p) : (checked?.items.find((i) => i.productId === productId)?.label ?? "—");
  };
  const enteredQty = (productId: Id<"products">) => parseQty(checked?.items.find((i) => i.productId === productId)?.qty ?? "");

  function addProduct(p: ProductSearchResult) {
    if (!items.some((i) => i.productId === p._id)) {
      const label = lineLabel({
        productName: p.name,
        lengthInches: p.lengthInches ?? null,
        sizeName: p.sizeName,
        colourName: p.colourName,
      });
      setItems([...items, { productId: p._id, label, qty: "" }]);
    }
    setPicking(false);
  }

  function handleCheck(event: FormEvent) {
    event.preventDefault();
    if (items.length === 0) return setProblem(t("needProduct"));
    if (items.length > MAX_CHECK_PRODUCTS) return setProblem(t("tooMany", { count: MAX_CHECK_PRODUCTS }));
    const qtys = items.map((i) => parseQty(i.qty));
    if (qtys.includes(null)) return setProblem(t("needQty"));
    if (!from || !to) return setProblem(t("needDates"));
    if (from > to) return setProblem(t("rangeOrder"));
    if (to > today) return setProblem(t("rangeFuture"));
    if (daysBetween(from, to) > MAX_CHECK_RANGE_DAYS) return setProblem(t("rangeTooLong", { days: MAX_CHECK_RANGE_DAYS }));
    setProblem(null);
    setChecked({
      items,
      args: {
        businessUnitKey: service,
        from,
        to,
        ...(locationId && filters && !filters.locked ? { locationId: locationId as Id<"locations"> } : {}),
        items: items.map((i, n) => ({ productId: i.productId, ...(qtys[n] !== undefined ? { qty: qtys[n] as number } : {}) })),
      },
    });
  }

  /** "P1: 2 sold, you entered 3" for each listed product whose quantity differs. */
  const qtyDiffs = (row: CheckRow) =>
    row.found
      .filter((f) => f.qtyDiff !== null && f.qtyDiff !== 0)
      .map((f) => t("qtyDiff", { product: labelOf(f.productId), sold: f.units, entered: enteredQty(f.productId) ?? 0 }));
  const extrasText = (row: CheckRow) =>
    row.extras.length === 0
      ? t("noExtras")
      : row.extras.map((e) => t("productUnits", { product: labelOf(e.productId), units: e.units })).join(", ");
  const closedBadge = (row: CheckRow) =>
    row.closed ? <Badge variant="outline">{row.closed === "marked" ? t("closedMarked") : t("closedWeekday")}</Badge> : null;
  const matchedBadge = (row: CheckRow) => (
    <Badge variant={row.missing.length === 0 ? "secondary" : "outline"}>
      {t("matched", { matched: row.matched, total: result?.listed ?? 0 })}
    </Badge>
  );

  const columns: DataTableColumn<CheckRow>[] = [
    {
      id: "day",
      header: t("dayHeader"),
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-medium">{dayLabel(row.original.day)}</span>
          {closedBadge(row.original)}
        </span>
      ),
      meta: { className: "whitespace-nowrap" },
    },
    { id: "shop", header: t("shopHeader"), cell: ({ row }) => row.original.locationName ?? "—" },
    { id: "matched", header: t("matchedHeader"), cell: ({ row }) => matchedBadge(row.original) },
    {
      id: "details",
      header: t("detailsHeader"),
      cell: ({ row }) => rowDetails(row.original),
      meta: { hideBelow: "md" },
    },
  ];

  const rowDetails = (row: CheckRow) => {
    const diffs = qtyDiffs(row);
    return (
      <span className="flex flex-col gap-0.5 text-xs">
        {row.missing.length > 0 ? (
          <span className="text-destructive">{t("missing", { products: row.missing.map(labelOf).join(", ") })}</span>
        ) : null}
        <span>{t("extras", { products: extrasText(row) })}</span>
        {diffs.length > 0 ? <span className="text-muted-foreground">{diffs.join(" · ")}</span> : null}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {back}
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      </div>

      <form onSubmit={handleCheck} className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-2">
          <Label required>{t("productsLabel")}</Label>
          {items.length === 0 ? <p className="text-sm text-muted-foreground">{t("noItems")}</p> : null}
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border empty:hidden">
            {items.map((item, n) => (
              <li key={item.productId} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 text-sm font-medium">{item.label}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={item.qty}
                  placeholder={t("qtyPlaceholder")}
                  aria-label={t("qtyLabel", { product: item.label })}
                  onChange={(e) => setItems(items.map((i, k) => (k === n ? { ...i, qty: e.target.value } : i)))}
                  className="h-11 w-20 sm:h-8"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 sm:size-8"
                  aria-label={t("remove", { product: item.label })}
                  onClick={() => setItems(items.filter((_, k) => k !== n))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("qtyHint")}</p>
          {canPick === false ? (
            <p className="text-sm text-muted-foreground">{t("noProductAccess")}</p>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              disabled={items.length >= MAX_CHECK_PRODUCTS}
              onClick={() => setPicking(true)}
            >
              <Plus aria-hidden />
              {t("addProduct")}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <div className="flex flex-col gap-2">
            <Label htmlFor="check-from" required>
              {t("fromLabel")}
            </Label>
            <Input id="check-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="h-11 sm:h-8" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="check-to" required>
              {t("toLabel")}
            </Label>
            <Input id="check-to" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} className="h-11 sm:h-8" required />
          </div>
        </div>

        {filters && !filters.locked ? (
          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="check-location">{t("shopLabel")}</Label>
            <NativeSelect id="check-location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-11 w-full sm:h-8">
              <option value="">{t("allShops")}</option>
              {filters.locations.map((l) => (
                <option key={l._id} value={l._id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : filters?.locked && filters.locations[0] ? (
          <p className="text-sm text-muted-foreground">{t("ownShop", { shop: filters.locations[0].name })}</p>
        ) : null}

        <RequiredFieldsHint />
        {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
        <Button type="submit" size="lg" className="min-h-11 self-start">
          <SearchCheck aria-hidden />
          {t("check")}
        </Button>
      </form>

      {checked ? (
        <section className="flex flex-col gap-3" aria-live="polite">
          {result === undefined ? (
            <p className="text-sm text-muted-foreground">{tSales("loading")}</p>
          ) : (
            <>
              <div>
                <h2 className="font-heading text-lg font-semibold">
                  {result.kind === "full"
                    ? t("fullTitle", { count: result.total })
                    : result.kind === "partial"
                      ? t("partialTitle")
                      : t("noneTitle")}
                </h2>
                {result.kind !== "none" ? <p className="text-sm text-muted-foreground">{t("openHint")}</p> : null}
                {result.results.length < result.total ? (
                  <p className="text-xs text-muted-foreground">{t("showing", { shown: result.results.length, total: result.total })}</p>
                ) : null}
                {result.markedClosedDays > 0 ? (
                  <p className="text-xs text-muted-foreground">{t("markedClosedNote", { count: result.markedClosedDays })}</p>
                ) : null}
                {result.truncated ? <p className="text-xs text-destructive">{t("truncated")}</p> : null}
              </div>
              {result.kind !== "none" ? (
                <DataTable
                  columns={columns}
                  data={result.results}
                  getRowId={(row) => `${row.locationId}:${row.day}`}
                  emptyMessage={t("noneTitle")}
                  onRowClick={setOpenDay}
                  renderCard={(row) => (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{dayLabel(row.day)}</span>
                        {matchedBadge(row)}
                      </div>
                      <p className="text-xs text-muted-foreground">{row.locationName ?? "—"}</p>
                      {closedBadge(row)}
                      {rowDetails(row)}
                    </div>
                  )}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("addProduct")}</DialogTitle>
          </DialogHeader>
          <ProductSearchList
            service={service}
            active={picking}
            selectedId={null}
            onSelect={addProduct}
            disabledIds={new Set(items.map((i) => i.productId))}
            disabledLabel={t("alreadyListed")}
            emptyLabel={t("noProductMatch")}
            label={t("productsLabel")}
          />
        </DialogContent>
      </Dialog>

      {openDay && checked ? (
        <DaySheet
          service={service}
          row={openDay}
          items={checked.items}
          labelOf={labelOf}
          dayLabel={dayLabel}
          onClose={() => setOpenDay(null)}
          onRequestEdit={setEditing}
        />
      ) : null}
      <SaleEditDialog saleId={editing} onClose={() => setEditing(null)} />
      <p className="text-xs text-muted-foreground">{t("note")}</p>
    </div>
  );
}
