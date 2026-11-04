"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import type { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { saleLineProblems, splitOverLots } from "../../../convex/lib/sales";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { ProductPhoto } from "@/components/products/product-photo";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/**
 * Picking products in stock at a location, shared by the sale form and the
 * exchange form: search the products, then one card per product with its
 * quantity (taken from its lots oldest first), price and - when the price
 * isn't the suggested one - a reason.
 */

export type StockLot = FunctionReturnType<typeof api.sales.options>["lots"][number];
export type ProductLine = {
  key: number;
  productId: Id<"products">;
  qty: number;
  price: number | null;
  reason: string;
};
export type StockProduct = { first: StockLot; onHand: number; lots: StockLot[] };

export function productLabel(
  lot: Pick<StockLot, "productName" | "lengthInches" | "sizeName" | "colourName">,
  inches: (n: number) => string,
) {
  return [lot.productName ?? "—", lot.lengthInches !== null ? inches(lot.lengthInches) : null, lot.sizeName, lot.colourName]
    .filter(Boolean)
    .join(" · ");
}

/** One entry per product in stock (its lots oldest first, as the server sorts them). */
export function groupLots(lots: StockLot[]): Map<Id<"products">, StockProduct> {
  const products = new Map<Id<"products">, StockProduct>();
  for (const lot of lots) {
    const entry = products.get(lot.productId) ?? { first: lot, onHand: 0, lots: [] };
    entry.onHand += lot.onHand;
    entry.lots.push(lot);
    products.set(lot.productId, entry);
  }
  return products;
}

/** Products whose name, SKU, colour, size or length match the search. */
export function matchProducts(products: Map<Id<"products">, StockProduct>, search: string): StockProduct[] {
  const term = search.trim().toLowerCase();
  if (!term) return [];
  return [...products.values()].filter(({ first }) =>
    [
      first.productName,
      first.sku,
      first.colourName,
      first.sizeName,
      first.lengthInches?.toString(),
      first.lengthInches ? `${first.lengthInches}"` : null,
    ]
      .filter(Boolean)
      .some((s) => s!.toLowerCase().includes(term)),
  );
}

/** What's wrong with a line: gone (no stock), price, qty, discountReason, stock. */
export function productLineProblems(line: ProductLine, entry: StockProduct | undefined): string[] {
  if (!entry) return ["gone"];
  if (line.price === null) return ["price"];
  const problems: string[] = saleLineProblems(
    { qty: line.qty, unitPrice: line.price, discountReason: line.reason },
    entry.first.suggestedPrice ?? undefined,
  );
  if (line.qty > entry.onHand) problems.push("stock");
  return problems;
}

/** A line as server lines: one per lot its units come from, so each keeps its cost. */
export function lotLines(line: ProductLine, entry: StockProduct | undefined) {
  return (splitOverLots(entry?.lots ?? [], line.qty) ?? []).map((part) => ({
    inventoryBatchId: part.lot._id,
    qty: part.qty,
    unitPrice: line.price ?? 0,
    ...(line.reason.trim() ? { discountReason: line.reason } : {}),
  }));
}

/** The search results: tap a product to add it. */
export function ProductSearchResults({
  matches,
  withPhotos,
  onPick,
}: {
  matches: StockProduct[];
  withPhotos: boolean;
  onPick: (productId: Id<"products">) => void;
}) {
  const t = useTranslations("Sales");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const inches = (n: number) => tProducts("inches", { inches: n });
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={t("results")}>
      {matches.length === 0 ? (
        <li className="p-3 text-sm text-muted-foreground">{t("noMatch")}</li>
      ) : (
        matches.slice(0, 20).map(({ first, onHand }) => (
          <li key={first.productId}>
            <button
              type="button"
              onClick={() => onPick(first.productId)}
              className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-3">
                {withPhotos ? <ProductPhoto url={first.photoUrl} size="md" /> : null}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{productLabel(first, inches)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {first.sku}
                    {" · "}
                    {first.suggestedPrice !== null ? formatMoney(first.suggestedPrice, "USD", locale) : t("noPriceShort")}
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{t("inStock", { count: onHand })}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

/** One product line: quantity, price, price reason, line total. */
export function ProductLineCard({
  service,
  line,
  entry,
  attempted,
  withPhotos,
  onChange,
  onRemove,
}: {
  service: BusinessUnitKey;
  line: ProductLine;
  entry: StockProduct | undefined;
  attempted: boolean;
  withPhotos: boolean;
  onChange: (patch: Partial<ProductLine>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Sales");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canSetPrice = useCan("products.set_price");
  const inches = (n: number) => tProducts("inches", { inches: n });
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
  const lot = entry?.first;
  const parts = entry ? splitOverLots(entry.lots, line.qty) : null;
  const problems = productLineProblems(line, entry);
  const differs = lot?.suggestedPrice != null && line.price !== null && line.price !== lot.suggestedPrice;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {withPhotos ? <ProductPhoto url={lot?.photoUrl} size="md" /> : null}
          <p className="font-medium">{lot ? productLabel(lot, inches) : t("goneLine")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 text-destructive"
          aria-label={t("removeLine")}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      {entry ? (
        <p className="text-xs text-muted-foreground">
          {t("inStock", { count: entry.onHand })}
          {parts && parts.length > 0
            ? ` · ${t("fromLots", {
                lots: parts
                  .map((p) => t("lotPart", { batch: p.lot.batchNumber ?? "—", date: date.format(p.lot.lotDate), qty: p.qty }))
                  .join(", "),
              })}`
            : null}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("qtyLabel")}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              aria-label={t("less")}
              disabled={line.qty <= 1}
              onClick={() => onChange({ qty: line.qty - 1 })}
            >
              <Minus aria-hidden />
            </Button>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={entry?.onHand}
              step={1}
              value={line.qty}
              aria-label={t("qtyLabel")}
              aria-invalid={problems.includes("qty") || problems.includes("stock") || undefined}
              onChange={(e) => onChange({ qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="h-11 w-16 text-center"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              aria-label={t("more")}
              disabled={!entry || line.qty >= entry.onHand}
              onClick={() => onChange({ qty: line.qty + 1 })}
            >
              <Plus aria-hidden />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t("priceLabel")}</span>
          <MoneyInput
            currency="USD"
            valueMinor={line.price}
            onCommit={(price) => onChange({ price })}
            aria-label={t("priceLabel")}
            aria-invalid={(attempted && problems.includes("price")) || undefined}
            className="h-11"
          />
          <span className="text-xs text-muted-foreground">
            {lot?.suggestedPrice != null ? (
              t("suggestedHint", { price: money(lot.suggestedPrice) })
            ) : (
              <>
                {t("noSuggestedPrice")}
                {canSetPrice ? (
                  <>
                    {" · "}
                    <Link href={`/${service}/products/prices`} className="text-primary underline-offset-4 hover:underline">
                      {t("setPrices")}
                    </Link>
                  </>
                ) : null}
              </>
            )}
          </span>
        </div>
      </div>
      {differs ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`reason-${line.key}`} required>
            {t("discountReasonLabel", { suggested: money(lot!.suggestedPrice!) })}
          </Label>
          <Input
            id={`reason-${line.key}`}
            value={line.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
            placeholder={t("discountReasonPlaceholder")}
            maxLength={300}
            aria-invalid={(attempted && problems.includes("discountReason")) || undefined}
            required
            className="h-11"
          />
        </div>
      ) : null}
      <p className="flex justify-between text-sm">
        <span className={cn("text-muted-foreground", problems.includes("stock") && "text-destructive")}>
          {entry && line.qty > entry.onHand ? t("onlyLeft", { count: entry.onHand }) : t("lineTotal")}
        </span>
        <span className="font-medium tabular-nums">{money((line.price ?? 0) * line.qty)}</span>
      </p>
    </div>
  );
}
