"use client";

import { useState } from "react";
import { Building2, MapPin, User } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import type { HolderType } from "../../../convex/lib/inventory";
import { formatMoney } from "../../../convex/lib/money";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type Overview = FunctionReturnType<typeof api.inventory.overview>;
type ProductRow = Overview["byProduct"][number];
type LotRow = Overview["byLot"][number];
type HolderRow = Overview["byHolder"][number];
type Holder = HolderRow["holder"];
type Product = ProductRow["product"];

const VIEWS = ["product", "lot", "holder"] as const;
type View = (typeof VIEWS)[number];

const HOLDER_ICONS: Record<HolderType, typeof Building2> = {
  business: Building2,
  location: MapPin,
  user: User,
};

function useHolderLabel() {
  const t = useTranslations("Inventory");
  return (holder: Holder) => (holder.type === "business" ? t("businessHolder") : holder.name);
}

function HolderName({ holder }: { holder: Holder }) {
  const label = useHolderLabel();
  const Icon = HOLDER_ICONS[holder.type];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{label(holder)}</span>
    </span>
  );
}

function ProductName({ product }: { product: Product }) {
  const tProducts = useTranslations("Products");
  return (
    <div className="min-w-36">
      <p className="font-medium">{product.name ?? "—"}</p>
      <p className="text-xs text-muted-foreground">
        {[
          product.sku,
          product.lengthInches !== null ? tProducts("inches", { inches: product.lengthInches }) : null,
          product.colourName,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

/** A small "who has how many" list, used in expanded rows. */
function Breakdown({ rows }: { rows: { key: string; label: React.ReactNode; qty: number }[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
          <span className="min-w-0">{r.label}</span>
          <span className="font-medium tabular-nums">{r.qty}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stock on hand, by product, by lot or by holder (stock.view). */
export function StockOverview({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Inventory");
  const locale = useLocale();
  const holderLabel = useHolderLabel();
  const canView = useCan("stock.view");
  const [view, setView] = useState<View>("product");
  const overview = useQuery(api.inventory.overview, canView ? { businessUnitKey: service } : "skip");

  if (canView === undefined) return null;
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const qtyCol = { meta: { className: "whitespace-nowrap tabular-nums font-medium" } };

  const productColumns: DataTableColumn<ProductRow>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <ProductName product={row.original.product} /> },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
    {
      id: "holders",
      header: t("whereHeader"),
      cell: ({ row }) => row.original.holders.map((h) => holderLabel(h.holder)).join(", "),
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "value",
      header: t("valueHeader"),
      cell: ({ row }) => money(row.original.value),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
  ];

  const lotColumns: DataTableColumn<LotRow>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <ProductName product={row.original.product} /> },
    {
      id: "batch",
      header: t("lotHeader"),
      cell: ({ row }) => row.original.lot.batchNumber ?? "—",
      meta: { className: "whitespace-nowrap font-mono text-xs" },
    },
    {
      id: "unitCost",
      header: t("unitCostHeader"),
      cell: ({ row }) => money(row.original.lot.unitCost),
      meta: { hideBelow: "md", className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "received",
      header: t("receivedHeader"),
      cell: ({ row }) => row.original.lot.receivedQty,
      meta: { hideBelow: "lg", className: "tabular-nums text-muted-foreground" },
    },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
  ];

  const holderColumns: DataTableColumn<HolderRow>[] = [
    { id: "holder", header: t("holderHeader"), cell: ({ row }) => <HolderName holder={row.original.holder} /> },
    {
      id: "type",
      header: t("holderTypeHeader"),
      cell: ({ row }) => t(`holderTypes.${row.original.holder.type}`),
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "lines",
      header: t("productsHeader"),
      cell: ({ row }) => t("lotCount", { count: row.original.lines.length }),
      meta: { hideBelow: "sm", className: "whitespace-nowrap text-muted-foreground" },
    },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
    {
      id: "value",
      header: t("valueHeader"),
      cell: ({ row }) => money(row.original.value),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
  ];

  const totalQty = overview?.byHolder.reduce((s, h) => s + h.qty, 0) ?? 0;
  const totalValue = overview?.byHolder.reduce((s, h) => s + h.value, 0) ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {overview?.scope === "own_location" ? t("subtitleOwn") : t("subtitle")}
        </p>
      </div>

      {overview ? (
        <section className="grid grid-cols-2 gap-3 sm:max-w-md" aria-label={t("totalsLabel")}>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t("unitsOnHand")}</p>
            <p className="text-lg font-semibold tabular-nums">{totalQty}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t("stockValue")}</p>
            <p className="text-lg font-semibold tabular-nums">{money(totalValue)}</p>
          </div>
        </section>
      ) : null}

      <div role="radiogroup" aria-label={t("viewLabel")} className="inline-flex self-start rounded-lg border border-border p-1">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            onClick={() => setView(v)}
            className={cn(
              "min-h-10 rounded-md px-3 text-sm font-medium",
              view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`views.${v}`)}
          </button>
        ))}
      </div>

      {view === "product" ? (
        <DataTable
          columns={productColumns}
          data={overview?.byProduct}
          getRowId={(r) => r.product.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.holders.map((h) => ({ key: h.holder.id, label: <HolderName holder={h.holder} />, qty: h.qty }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-start justify-between gap-3">
              <ProductName product={r.product} />
              <div className="text-right">
                <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
                <p className="text-xs text-muted-foreground">{money(r.value)}</p>
              </div>
            </div>
          )}
        />
      ) : view === "lot" ? (
        <DataTable
          columns={lotColumns}
          data={overview?.byLot}
          getRowId={(r) => r.lot.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.holders.map((h) => ({ key: h.holder.id, label: <HolderName holder={h.holder} />, qty: h.qty }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-start justify-between gap-3">
              <div>
                <ProductName product={r.product} />
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.lot.batchNumber ?? "—"} · {money(r.lot.unitCost)} · {t("receivedCount", { count: r.lot.receivedQty })}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={holderColumns}
          data={overview?.byHolder}
          getRowId={(r) => r.holder.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.lines.map((l) => ({
                key: l.lot.id,
                label: (
                  <span>
                    {l.product.name ?? "—"}{" "}
                    <span className="text-xs text-muted-foreground">
                      {[l.product.sku, l.lot.batchNumber].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                ),
                qty: l.qty,
              }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-center justify-between gap-3">
              <div>
                <HolderName holder={r.holder} />
                <p className="text-xs text-muted-foreground">
                  {t("lotCount", { count: r.lines.length })} · {money(r.value)}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
            </div>
          )}
        />
      )}
      <p className="text-xs text-muted-foreground">{t("valueHint")}</p>
    </div>
  );
}
