"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Minus, Plus } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { MAX_EXCHANGE_DAYS, returnedDiscountShare } from "../../../convex/lib/sales";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { COLLECTION_METHODS, type CollectionMethod } from "../../../convex/lib/credit";
import { Link } from "@/i18n/navigation";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { ProductPhoto } from "@/components/products/product-photo";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { useProductLineLabel } from "./use-product-line-label";
import {
  ProductLineCard,
  ProductSearchResults,
  groupLots,
  lotLines,
  matchProducts,
  productLineProblems,
  type ProductLine,
} from "./product-lines";

/**
 * Exchange products of a sale (sales.exchange): what the customer brings
 * back (per line of the sale), what they take instead (products in stock at
 * the sale's location) and the difference - paid now, or given back after
 * approval. The server re-checks everything.
 */
export function ExchangeForm({ service, saleId }: { service: BusinessUnitKey; saleId: string }) {
  const t = useTranslations("SaleExchange");
  const tSales = useTranslations("Sales");
  const locale = useLocale();
  const lineLabel = useProductLineLabel();
  const canSell = useCan("sales.create");
  const options = useQuery(api.sales.exchangeOptions, canSell ? { saleId: saleId as Id<"sales"> } : "skip");
  const exchange = useMutation(api.sales.exchange);
  // Units brought back, per sale line.
  const [returned, setReturned] = useState<Record<string, number>>({});
  const [lines, setLines] = useState<ProductLine[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState<CollectionMethod>("cash");
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ status: "completed" | "pending"; number?: string; difference: number } | null>(null);

  if (canSell === undefined || (canSell && options === undefined)) {
    return <p className="text-sm text-muted-foreground">{tSales("loading")}</p>;
  }
  if (!canSell) return <p className="text-sm text-muted-foreground">{tSales("cannotSell")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const back = (
    <Link
      href={`/${service}/sales`}
      className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {tSales("backToList")}
    </Link>
  );

  if (!options) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  }

  const header = (
    <div>
      <h1 className="font-heading text-2xl font-bold text-primary">{t("title", { number: options.number })}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {[time.format(options.createdAt), options.locationName, money(options.totalAmount)].filter(Boolean).join(" · ")}
      </p>
    </div>
  );

  if (done) {
    return (
      <div className="flex flex-col gap-5">
        {back}
        {header}
        <p role="status" className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
          {done.status === "pending"
            ? t("sentForApproval", { amount: money(-done.difference) })
            : done.difference > 0
              ? t("recordedPaid", { number: done.number ?? "", amount: money(done.difference) })
              : t("recordedEven", { number: done.number ?? "" })}
        </p>
      </div>
    );
  }

  const blockedBy = options.refusal
    ? t("tooLateOrNot", { days: MAX_EXCHANGE_DAYS })
    : options.pendingEdit
      ? t("pendingEdit")
      : options.pendingExchange
        ? t("pendingExchange")
        : options.lines.every((l) => l.returnable === 0)
          ? t("nothingLeft")
          : null;
  if (blockedBy) {
    return (
      <div className="flex flex-col gap-5">
        {back}
        {header}
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">{blockedBy}</p>
      </div>
    );
  }

  const products = groupLots(options.lots);
  const matches = matchProducts(products, search);
  // What the returned units were paid (their price less their share of a whole-sale discount).
  const returnedValue = options.lines.reduce((sum, l) => {
    const qty = returned[l.saleItemId] ?? 0;
    return sum + l.unitPrice * qty - returnedDiscountShare(l, l.alreadyReturned, qty);
  }, 0);
  const returnedCount = Object.values(returned).reduce((s, n) => s + n, 0);
  const givenTotal = lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
  const difference = givenTotal - returnedValue;
  const isRefund = difference < 0;
  const allProblems = new Set(lines.flatMap((l) => productLineProblems(l, products.get(l.productId))));
  const blocker =
    returnedCount === 0
      ? t("needReturned")
      : lines.length === 0
        ? t("needGiven")
        : allProblems.has("gone")
          ? tSales("needGone")
          : allProblems.has("price")
            ? tSales("needPrice")
            : allProblems.has("discountReason")
              ? tSales("needReason")
              : allProblems.has("qty")
                ? tSales("needQty")
                : allProblems.has("stock")
                  ? tSales("needStock")
                  : isRefund && !reason.trim()
                    ? t("needRefundReason")
                    : null;

  function addProduct(productId: Id<"products">) {
    const entry = products.get(productId);
    if (!entry) return;
    const existing = lines.find((l) => l.productId === productId);
    if (existing) {
      updateLine(existing.key, { qty: Math.min(existing.qty + 1, entry.onHand) });
    } else {
      setLines((prev) => [...prev, { key: nextKey, productId, qty: 1, price: entry.first.suggestedPrice ?? null, reason: "" }]);
      setNextKey((k) => k + 1);
    }
    setSearch("");
  }

  function updateLine(key: number, patch: Partial<ProductLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocker || !options) {
      setAttempted(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await exchange({
        saleId: options._id,
        changes: {
          returned: Object.entries(returned)
            .filter(([, qty]) => qty > 0)
            .map(([saleItemId, qty]) => ({ saleItemId: saleItemId as Id<"saleItems">, qty })),
          given: lines.flatMap((l) => lotLines(l, products.get(l.productId))),
          ...(difference !== 0 ? { settlementMethod: method } : {}),
        },
        ...(reason.trim() ? { reason } : {}),
      });
      setDone({
        status: result.status,
        ...(result.status === "completed" ? { number: result.number } : {}),
        difference: result.differenceAmount,
      });
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { message?: string } | string) : null;
      setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 pb-28">
      {back}
      <div>
        {header}
        <RequiredFieldsHint />
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="exchange-returned">
        <div>
          <h2 id="exchange-returned" className="font-medium">
            {t("returnedTitle")} <span className="text-destructive">*</span>
          </h2>
          <p className="text-xs text-muted-foreground">{t("returnedHint")}</p>
        </div>
        <ul className="flex flex-col gap-2">
          {options.lines.map((line) => {
            const qty = returned[line.saleItemId] ?? 0;
            const setQty = (n: number) => setReturned((prev) => ({ ...prev, [line.saleItemId]: Math.max(0, Math.min(n, line.returnable)) }));
            return (
              <li
                key={line.saleItemId}
                className={cn("flex flex-col gap-2 rounded-lg border p-3", qty > 0 ? "border-primary bg-primary/5" : "border-border")}
              >
                <div className="flex min-w-0 items-center gap-3">
                  {withPhotos ? <ProductPhoto url={line.photoUrl} size="md" /> : null}
                  <div className="min-w-0">
                    <p className="font-medium">{lineLabel(line)}</p>
                    <p className="text-xs text-muted-foreground">
                      {tSales("qtyAtPrice", { qty: line.qty, price: money(line.unitPrice) })}
                      {line.alreadyReturned > 0 ? ` · ${t("alreadyReturned", { count: line.alreadyReturned })}` : null}
                    </p>
                  </div>
                </div>
                {line.returnable > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={tSales("less")}
                        disabled={qty <= 0}
                        onClick={() => setQty(qty - 1)}
                      >
                        <Minus aria-hidden />
                      </Button>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.returnable}
                        step={1}
                        value={qty}
                        aria-label={t("returnedQtyLabel")}
                        onChange={(e) => setQty(Math.floor(Number(e.target.value) || 0))}
                        className="h-11 w-16 text-center"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={tSales("more")}
                        disabled={qty >= line.returnable}
                        onClick={() => setQty(qty + 1)}
                      >
                        <Plus aria-hidden />
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">{t("upTo", { count: line.returnable })}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("allReturned")}</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="exchange-given">
        <div>
          <h2 id="exchange-given" className="font-medium">
            {t("givenTitle")} <span className="text-destructive">*</span>
          </h2>
          <p className="text-xs text-muted-foreground">{t("givenHint", { location: options.locationName ?? "—" })}</p>
        </div>
        <DataTableSearch value={search} onChange={setSearch} placeholder={tSales("searchPlaceholder")} className="sm:max-w-none" />
        {search.trim() ? (
          <ProductSearchResults matches={matches} withPhotos={withPhotos} onPick={addProduct} />
        ) : options.lots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tSales("noStockHere")}</p>
        ) : null}
        {lines.map((line) => (
          <ProductLineCard
            key={line.key}
            service={service}
            line={line}
            entry={products.get(line.productId)}
            attempted={attempted}
            withPhotos={withPhotos}
            onChange={(patch) => updateLine(line.key, patch)}
            onRemove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={t("summaryLabel")}>
        <p className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("returnedValue")}</span>
          <span className="tabular-nums">{money(returnedValue)}</span>
        </p>
        <p className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("givenTotal")}</span>
          <span className="tabular-nums">{money(givenTotal)}</span>
        </p>
        <p className="flex justify-between border-t border-border pt-2 font-medium">
          <span>{difference > 0 ? t("customerPays") : isRefund ? t("giveBack") : t("even")}</span>
          <span className={cn("tabular-nums", isRefund && "text-destructive")}>{money(Math.abs(difference))}</span>
        </p>
        {isRefund ? <p className="rounded-md bg-amber-500/10 p-2 text-xs">{t("refundNeedsApproval")}</p> : null}
      </section>

      {difference !== 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            {isRefund ? t("refundMethodLabel") : t("payMethodLabel")} <span className="text-destructive">*</span>
          </legend>
          <div role="radiogroup" className="grid grid-cols-2 gap-2">
            {COLLECTION_METHODS.map((m) => (
              <label
                key={m}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium",
                  method === m ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                <input type="radio" name="exchange-method" className="sr-only" checked={method === m} onChange={() => setMethod(m)} />
                {tSales(`payments.${m}`)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="exchange-reason" required={isRefund}>
          {t("reasonLabel")}
        </Label>
        <Input
          id="exchange-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("reasonPlaceholder")}
          maxLength={300}
          required={isRefund}
          aria-invalid={(attempted && isRefund && !reason.trim()) || undefined}
          className="h-11"
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:sticky md:-mx-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {difference > 0 ? t("customerPays") : isRefund ? t("giveBack") : t("even")}
            </p>
            <p className={cn("text-xl font-semibold tabular-nums", isRefund && "text-destructive")}>{money(Math.abs(difference))}</p>
            {attempted && blocker ? (
              <p className="text-xs text-destructive" role="alert">
                {blocker}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="lg" className="min-h-12 shrink-0 px-6" disabled={submitting}>
            {submitting ? t("saving") : isRefund ? t("submitRefund") : t("submit")}
          </Button>
        </div>
      </div>
    </form>
  );
}
