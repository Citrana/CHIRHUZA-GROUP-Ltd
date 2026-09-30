"use client";

import { useState } from "react";
import { useMutation, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type PriceRow = PaginatedQueryItem<typeof api.products.priceList>;

/** Edit a product's suggested selling price (products.set_price). */
function SellingPriceEditor({ row }: { row: PriceRow }) {
  const t = useTranslations("Prices");
  const setSuggestedPrice = useMutation(api.products.setSuggestedPrice);
  const [price, setPrice] = useState<number | null>(row.suggestedPrice);
  const [shown, setShown] = useState(row.suggestedPrice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  if (row.suggestedPrice !== shown) {
    setShown(row.suggestedPrice);
    setPrice(row.suggestedPrice);
  }

  async function save(next: number | null) {
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      await setSuggestedPrice({ productId: row._id, price: next });
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const id = `price-${row._id}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <Label htmlFor={id}>{t("sellingPriceLabel")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <MoneyInput
          id={id}
          currency="USD"
          valueMinor={price}
          onCommit={(value) => {
            setPrice(value);
            setSaved(false);
          }}
          className="w-40"
        />
        <Button type="button" className="min-h-10" disabled={busy} onClick={() => save(price)}>
          {t("save")}
        </Button>
        {row.suggestedPrice !== null ? (
          <Button type="button" variant="ghost" className="min-h-10" disabled={busy} onClick={() => save(null)}>
            {t("clear")}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{t("saveError")}</p> : null}
      {saved ? <p className="text-sm text-muted-foreground">{t("saved")}</p> : null}
      <p className="text-xs text-muted-foreground">{t("sellingPriceHint")}</p>
    </div>
  );
}

/**
 * The price list: per product, the suggested selling price, what its lots
 * were bought at, what's on hand and the last price it sold at. Open a row
 * for the lots (and, for products.set_price holders, to set the price).
 */
export function PriceListPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Prices");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canStock = useCan("stock.view");
  const canSalesView = useCan("sales.view");
  const canSell = useCan("sales.create");
  const canSetPrice = useCan("products.set_price");
  const allowed = canStock || canSalesView || canSell;
  const loading = canStock === undefined;
  const [search, setSearch] = useState("");
  const { results, pagination } = useCursorPaginatedQuery(
    api.products.priceList,
    allowed ? { businessUnitKey: service, ...(search.trim() ? { search } : {}) } : "skip",
  );

  if (loading) return null;
  if (!allowed) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const productLine = (row: PriceRow) =>
    [row.name, row.lengthInches !== null ? tProducts("inches", { inches: row.lengthInches }) : null, row.colourName]
      .filter(Boolean)
      .join(" · ");
  const boughtAt = (row: PriceRow) =>
    row.minCost === null
      ? t("notBoughtYet")
      : row.minCost === row.maxCost
        ? money(row.minCost)
        : `${money(row.minCost)} – ${money(row.maxCost!)}`;
  const sellingPrice = (row: PriceRow) =>
    row.suggestedPrice !== null ? (
      <span className="font-medium tabular-nums">{money(row.suggestedPrice)}</span>
    ) : (
      <Badge variant="outline">{t("noPrice")}</Badge>
    );

  const columns: DataTableColumn<PriceRow>[] = [
    {
      id: "product",
      header: t("productHeader"),
      cell: ({ row }) => (
        <div className="min-w-36">
          <p className="font-medium">{productLine(row.original)}</p>
          <p className="text-xs text-muted-foreground">{row.original.sku}</p>
        </div>
      ),
    },
    { id: "selling", header: t("sellingHeader"), cell: ({ row }) => sellingPrice(row.original) },
    {
      id: "bought",
      header: t("boughtHeader"),
      cell: ({ row }) => boughtAt(row.original),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums text-muted-foreground" },
    },
    {
      id: "onHand",
      header: t("onHandHeader"),
      cell: ({ row }) => row.original.onHand,
      meta: { hideBelow: "md", className: "tabular-nums" },
    },
    {
      id: "lastSold",
      header: t("lastSoldHeader"),
      cell: ({ row }) =>
        row.original.lastSold
          ? t("lastSoldValue", { price: money(row.original.lastSold.unitPrice), date: date.format(row.original.lastSold.soldAt) })
          : "—",
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  const details = (row: PriceRow) => (
    <div className="flex flex-col gap-3 text-sm">
      {canSetPrice ? <SellingPriceEditor row={row} /> : null}
      {row.lots.length === 0 ? (
        <p className="text-muted-foreground">{t("noLots")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
          {row.lots.map((lot) => (
            <li key={lot._id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2">
              <span className="min-w-0">
                <span className="block font-medium">{t("boughtAtValue", { cost: money(lot.unitCost) })}</span>
                <span className="block text-xs text-muted-foreground">
                  {[lot.batchNumber, date.format(lot.purchasedAt), t("receivedCount", { count: lot.receivedQty })]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block">{t("onHandCount", { count: lot.onHand })}</span>
                {lot.marginAtSuggested !== null ? (
                  <span className={cn("block text-xs", lot.marginAtSuggested < 0 ? "text-destructive" : "text-muted-foreground")}>
                    {t("marginAtPrice", { margin: money(lot.marginAtSuggested) })}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {row.lastSold ? (
        <p className="text-muted-foreground">
          {t("lastSoldLine", { price: money(row.lastSold.unitPrice), date: date.format(row.lastSold.soldAt) })}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{canSetPrice ? t("subtitleEdit") : t("subtitle")}</p>
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(row) => row._id}
        emptyMessage={t("empty")}
        search={{ value: search, onChange: setSearch, placeholder: t("searchPlaceholder") }}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={details}
        renderCard={(row) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{productLine(row)}</p>
              <p className="text-xs text-muted-foreground">
                {row.sku} · {t("boughtShort", { cost: boughtAt(row) })} · {t("onHandCount", { count: row.onHand })}
              </p>
            </div>
            <div className="shrink-0 text-right">{sellingPrice(row)}</div>
          </div>
        )}
      />
    </div>
  );
}
