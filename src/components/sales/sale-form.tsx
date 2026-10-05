"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, Minus, Plus, Trash2 } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import {
  MAX_BACKDATE_DAYS,
  PAYMENT_METHODS,
  saleLineProblems,
  type PaymentMethod,
} from "../../../convex/lib/sales";
import {
  BUSINESS_TIME_ZONE,
  addBusinessDays,
  businessDayOf,
  businessDayStartUtc,
} from "../../../convex/lib/time";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { COLLECTION_METHODS, type CollectionMethod } from "../../../convex/lib/credit";
import { Link } from "@/i18n/navigation";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { ProductPhoto } from "@/components/products/product-photo";
import { CustomerPicker, type PickedCustomer } from "@/components/sales/customer-picker";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type Options = FunctionReturnType<typeof api.sales.options>;
type Lot = Options["lots"][number];
type Line = {
  key: number;
  productId: Id<"products">;
  lotId: Id<"inventoryBatches">;
  qty: number;
  price: number | null;
  reason: string;
};

const LOCATION_KEY = "sale-location";

function rememberedLocation(): string {
  try {
    return localStorage.getItem(LOCATION_KEY) ?? "";
  } catch {
    return "";
  }
}

function productLabel(lot: Pick<Lot, "productName" | "lengthInches" | "sizeName" | "colourName">, inches: (n: number) => string) {
  return [lot.productName ?? "—", lot.lengthInches !== null ? inches(lot.lengthInches) : null, lot.sizeName, lot.colourName]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The phone sale form: where (locked to the seller's own location for
 * own_location sellers), what (search products in stock there, pick the
 * lot, quantity and price), how it's paid. The server re-checks
 * everything and refuses to sell stock that isn't there.
 */
export function SaleForm({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Sales");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canSell = useCan("sales.create");
  const [picked, setPicked] = useState(rememberedLocation);
  const options = useQuery(
    api.sales.options,
    canSell ? { businessUnitKey: service, ...(picked ? { locationId: picked as Id<"locations"> } : {}) } : "skip",
  );
  const create = useMutation(api.sales.create);
  const [lines, setLines] = useState<Line[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [search, setSearch] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  // Optional name on a cash / mobile money sale.
  const [customer, setCustomer] = useState("");
  // Credit: the customer from the customer list, what they paid now and how.
  const [creditCustomer, setCreditCustomer] = useState<PickedCustomer | null>(null);
  const [paidNow, setPaidNow] = useState<number | null>(0);
  const [paidNowMethod, setPaidNowMethod] = useState<CollectionMethod>("cash");
  // The agreed total, for the lines' total it was entered against: when the
  // lines change, it goes back to following their total. Lower than the
  // lines is a whole-sale discount and needs a reason.
  const [agreed, setAgreed] = useState<{ value: number; linesTotal: number } | null>(null);
  const [saleReason, setSaleReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    number: string;
    total: number;
    soldOn: string;
    credit?: { customer: string; balance: number };
  } | null>(null);
  // The day of the sale: today, or up to MAX_BACKDATE_DAYS back for a sale
  // recorded late. Kept after recording, to enter several late sales.
  const [today, setToday] = useState(() => businessDayOf(Date.now()));
  const [soldOn, setSoldOn] = useState(today);
  const [submitting, setSubmitting] = useState(false);
  // Problems are only highlighted once the seller has tried to record.
  const [attempted, setAttempted] = useState(false);
  const canSetPrice = useCan("products.set_price");

  if (canSell === undefined) return null;
  if (!canSell) return <p className="text-sm text-muted-foreground">{t("cannotSell")}</p>;

  const inches = (n: number) => tProducts("inches", { inches: n });
  // Mode products have a photo: show it so sellers pick the right item.
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const earliest = addBusinessDays(today, -MAX_BACKDATE_DAYS);
  const longDay = (day: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE }).format(
      businessDayStartUtc(day) + 12 * 3600_000,
    );
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
  const lots = options?.lots ?? [];
  const lotById = new Map(lots.map((l) => [l._id, l]));
  const locationId = options?.locationId ?? null;

  // Products in stock here, for the search list (one entry per product).
  const products = new Map<Id<"products">, { first: Lot; onHand: number; lots: Lot[] }>();
  for (const lot of lots) {
    const entry = products.get(lot.productId) ?? { first: lot, onHand: 0, lots: [] };
    entry.onHand += lot.onHand;
    entry.lots.push(lot);
    products.set(lot.productId, entry);
  }
  const term = search.trim().toLowerCase();
  const matches = term
    ? [...products.values()].filter(({ first }) =>
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
      )
    : [];

  const usedLots = new Set(lines.map((l) => l.lotId));
  const problemsOf = (line: Line): string[] => {
    const lot = lotById.get(line.lotId);
    if (!lot) return ["gone"];
    if (line.price === null) return ["price"];
    const problems: string[] = saleLineProblems(
      { qty: line.qty, unitPrice: line.price, discountReason: line.reason },
      lot.suggestedPrice ?? undefined,
    );
    if (line.qty > lot.onHand) problems.push("stock");
    return problems;
  };
  const linesTotal = lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
  const agreedTotal = agreed && agreed.linesTotal === linesTotal ? agreed.value : null;
  const total = agreedTotal ?? linesTotal;
  const discounted = total < linesTotal;
  const isCredit = payment === "credit";
  const balance = total - (paidNow ?? 0);
  // The first thing stopping the sale, in words (shown after a try).
  const allProblems = new Set(lines.flatMap(problemsOf));
  const blocker = !locationId
    ? t("needLocation")
    : lines.length === 0
      ? t("needLines")
      : allProblems.has("gone")
        ? t("needGone")
        : allProblems.has("price")
          ? t("needPrice")
          : allProblems.has("discountReason")
            ? t("needReason")
            : allProblems.has("qty")
              ? t("needQty")
              : allProblems.has("stock")
                ? t("needStock")
                : total > linesTotal
                  ? t("needTotal")
                  : discounted && !saleReason.trim()
                    ? t("needSaleReason")
                    : isCredit && !creditCustomer
                      ? t("needCustomer")
                      : isCredit && (paidNow ?? 0) > total
                        ? t("needPaidNow")
                        : null;

  function update(key: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addProduct(productId: Id<"products">) {
    const entry = products.get(productId);
    if (!entry) return;
    setDone(null);
    const existing = lines.find((l) => l.productId === productId);
    if (existing) {
      const lot = lotById.get(existing.lotId);
      update(existing.key, { qty: Math.min(existing.qty + 1, lot?.onHand ?? existing.qty) });
    } else {
      const lot = entry.lots.find((l) => !usedLots.has(l._id)) ?? entry.lots[0];
      setLines((prev) => [
        ...prev,
        { key: nextKey, productId, lotId: lot._id, qty: 1, price: lot.suggestedPrice ?? null, reason: "" },
      ]);
      setNextKey((k) => k + 1);
    }
    setSearch("");
  }

  function chooseLocation(id: string) {
    setPicked(id);
    setLines([]);
    setDone(null);
    try {
      localStorage.setItem(LOCATION_KEY, id);
    } catch {
      // Remembering the location is only a convenience.
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocker || !locationId) {
      setAttempted(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await create({
        businessUnitKey: service,
        ...(options?.locationLocked ? {} : { locationId }),
        paymentMethod: payment,
        ...(soldOn !== today ? { soldOn } : {}),
        ...(!isCredit && customer.trim() ? { customerName: customer } : {}),
        ...(isCredit && creditCustomer
          ? {
              customerId: creditCustomer._id,
              paidNow: paidNow ?? 0,
              ...((paidNow ?? 0) > 0 ? { paidNowMethod } : {}),
            }
          : {}),
        ...(agreedTotal !== null && agreedTotal !== linesTotal
          ? { agreedTotal, ...(saleReason.trim() ? { saleDiscountReason: saleReason } : {}) }
          : {}),
        lines: lines.map((l) => ({
          inventoryBatchId: l.lotId,
          qty: l.qty,
          unitPrice: l.price ?? 0,
          ...(l.reason.trim() ? { discountReason: l.reason } : {}),
        })),
      });
      setDone({
        number: result.number,
        total,
        soldOn: result.soldOn,
        ...(isCredit && creditCustomer ? { credit: { customer: creditCustomer.name, balance } } : {}),
      });
      // The form may stay open past midnight: "today" per the server.
      setToday(result.recordedOn);
      setLines([]);
      setCustomer("");
      setCreditCustomer(null);
      setPaidNow(0);
      setPaidNowMethod("cash");
      setAgreed(null);
      setSaleReason("");
      setPayment("cash");
      setAttempted(false);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string } | string) : null;
      setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 pb-28">
      <Link
        href={`/${service}/sales`}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("backToList")}
      </Link>
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("newTitle")}</h1>
        <RequiredFieldsHint />
      </div>

      {done ? (
        <p role="status" className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
          {done.credit
            ? t("recordedCredit", {
                number: done.number,
                total: money(done.total),
                customer: done.credit.customer,
                balance: money(done.credit.balance),
              })
            : done.soldOn === today
              ? t("recorded", { number: done.number, total: money(done.total) })
              : t("recordedOn", { number: done.number, total: money(done.total), date: longDay(done.soldOn) })}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="sale-date" required>
          {t("dateLabel")}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="sale-date"
            type="date"
            value={soldOn}
            min={earliest}
            max={today}
            required
            onChange={(e) => {
              const day = e.target.value;
              if (day >= earliest && day <= today) setSoldOn(day);
            }}
            className="h-11 w-44"
          />
          {soldOn !== today ? (
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setSoldOn(today)}>
              {t("backToToday")}
            </Button>
          ) : null}
        </div>
        {soldOn !== today ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
            {t("pastDateNote", { date: longDay(soldOn) })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("dateHint", { days: MAX_BACKDATE_DAYS })}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="sale-location" required>
          {t("locationLabel")}
        </Label>
        {options === undefined ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : options.locationLocked ? (
          <p className="flex min-h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm font-medium">
            {options.locations[0]?.name ?? t("noOwnLocation")}
          </p>
        ) : (
          <NativeSelect id="sale-location" value={locationId ?? ""} onChange={(e) => chooseLocation(e.target.value)} required>
            <option value="" disabled>
              {t("chooseLocation")}
            </option>
            {options.locations.map((l) => (
              <option key={l._id} value={l._id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {locationId ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="sale-search">{t("addProduct")}</Label>
          <DataTableSearch value={search} onChange={setSearch} placeholder={t("searchPlaceholder")} className="sm:max-w-none" />
          {term ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={t("results")}>
              {matches.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">{t("noMatch")}</li>
              ) : (
                matches.slice(0, 20).map(({ first, onHand }) => (
                  <li key={first.productId}>
                    <button
                      type="button"
                      onClick={() => addProduct(first.productId)}
                      className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        {withPhotos ? <ProductPhoto url={first.photoUrl} size="md" /> : null}
                        <span className="min-w-0">
                        <span className="block truncate font-medium">{productLabel(first, inches)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {first.sku}
                          {" · "}
                          {first.suggestedPrice !== null ? money(first.suggestedPrice) : t("noPriceShort")}
                        </span>
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{t("inStock", { count: onHand })}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : lots.length === 0 && options ? (
            <p className="text-sm text-muted-foreground">{t("noStockHere")}</p>
          ) : null}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label={t("linesLabel")}>
          {lines.map((line) => {
            const lot = lotById.get(line.lotId);
            const productLots = products.get(line.productId)?.lots ?? [];
            const problems = problemsOf(line);
            const differs = lot?.suggestedPrice != null && line.price !== null && line.price !== lot.suggestedPrice;
            return (
              <div key={line.key} className="flex flex-col gap-3 rounded-lg border border-border p-3">
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
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`lot-${line.key}`} className="text-xs text-muted-foreground">
                    {t("lotLabel")}
                  </Label>
                  <NativeSelect
                    id={`lot-${line.key}`}
                    value={line.lotId}
                    onChange={(e) => {
                      const next = lotById.get(e.target.value as Id<"inventoryBatches">);
                      if (next) update(line.key, { lotId: next._id, qty: Math.min(line.qty, next.onHand) });
                    }}
                  >
                    {productLots.map((l) => (
                      <option key={l._id} value={l._id} disabled={l._id !== line.lotId && usedLots.has(l._id)}>
                        {t("lotOption", {
                          batch: l.batchNumber ?? "—",
                          cost: money(l.unitCost),
                          date: date.format(l.lotDate),
                          left: l.onHand,
                        })}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
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
                        onClick={() => update(line.key, { qty: line.qty - 1 })}
                      >
                        <Minus aria-hidden />
                      </Button>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={lot?.onHand}
                        step={1}
                        value={line.qty}
                        aria-label={t("qtyLabel")}
                        aria-invalid={problems.includes("qty") || problems.includes("stock") || undefined}
                        onChange={(e) => update(line.key, { qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                        className="h-11 w-16 text-center"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={t("more")}
                        disabled={!lot || line.qty >= lot.onHand}
                        onClick={() => update(line.key, { qty: line.qty + 1 })}
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
                      onCommit={(price) => update(line.key, { price })}
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
                      onChange={(e) => update(line.key, { reason: e.target.value })}
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
                    {lot && line.qty > lot.onHand ? t("onlyLeft", { count: lot.onHand }) : t("lineTotal")}
                  </span>
                  <span className="font-medium tabular-nums">{money((line.price ?? 0) * line.qty)}</span>
                </p>
              </div>
            );
          })}
        </section>
      ) : null}

      {lines.length > 0 ? (
        <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={t("totalToPayLabel")}>
          <p className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("linesTotalLabel")}</span>
            <span className="tabular-nums">{money(linesTotal)}</span>
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sale-total" required>
              {t("totalToPayLabel")}
            </Label>
            <MoneyInput
              id="sale-total"
              currency="USD"
              valueMinor={total}
              onCommit={(value) => setAgreed(value === null || value === linesTotal ? null : { value, linesTotal })}
              aria-invalid={(attempted && total > linesTotal) || undefined}
              className="h-11"
              required
            />
            <span className="text-xs text-muted-foreground">{t("totalToPayHint")}</span>
          </div>
          {discounted ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="sale-discount-reason" required>
                {t("saleDiscountReasonLabel")}
              </Label>
              <Input
                id="sale-discount-reason"
                value={saleReason}
                onChange={(e) => setSaleReason(e.target.value)}
                placeholder={t("saleDiscountReasonPlaceholder")}
                maxLength={300}
                aria-invalid={(attempted && !saleReason.trim()) || undefined}
                required
                className="h-11"
              />
            </div>
          ) : null}
        </section>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          {t("paymentLabel")} <span className="text-destructive">*</span>
        </legend>
        <div role="radiogroup" className="grid grid-cols-3 gap-2">
          {PAYMENT_METHODS.map((method) => (
            <label
              key={method}
              className={cn(
                "flex min-h-12 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium",
                payment === method ? "border-primary bg-primary text-primary-foreground" : "border-border",
              )}
            >
              <input
                type="radio"
                name="payment"
                className="sr-only"
                checked={payment === method}
                onChange={() => setPayment(method)}
              />
              {t(`payments.${method}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {isCredit ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("customerLabel")} <span className="text-destructive">*</span>
            </span>
            <CustomerPicker
              service={service}
              value={creditCustomer}
              onChange={setCreditCustomer}
              invalid={attempted && !creditCustomer}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="sale-paid-now" required>
                {t("paidNowLabel")}
              </Label>
              <MoneyInput
                id="sale-paid-now"
                currency="USD"
                valueMinor={paidNow}
                onCommit={setPaidNow}
                aria-invalid={(attempted && (paidNow ?? 0) > total) || undefined}
                className="h-11"
                required
              />
              <span className="text-xs text-muted-foreground">{t("paidNowHint")}</span>
            </div>
            {(paidNow ?? 0) > 0 ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">{t("paidNowMethodLabel")}</legend>
                <div role="radiogroup" className="grid grid-cols-2 gap-2">
                  {COLLECTION_METHODS.map((method) => (
                    <label
                      key={method}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 text-center text-sm font-medium",
                        paidNowMethod === method ? "border-primary bg-primary text-primary-foreground" : "border-border",
                      )}
                    >
                      <input
                        type="radio"
                        name="paid-now-method"
                        className="sr-only"
                        checked={paidNowMethod === method}
                        onChange={() => setPaidNowMethod(method)}
                      />
                      {t(`payments.${method}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
          <p className="flex justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{t("balanceLabel")}</span>
            <span className={cn("font-semibold tabular-nums", balance < 0 && "text-destructive")}>{money(Math.max(balance, 0))}</span>
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="sale-customer">{t("customerLabel")}</Label>
          <Input
            id="sale-customer"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            maxLength={120}
            placeholder={t("customerOptional")}
            className="h-11"
          />
        </div>
      )}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:sticky md:-mx-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t("itemsCount", { count: lines.reduce((s, l) => s + l.qty, 0) })}</p>
            <p className="text-xl font-semibold tabular-nums">{money(total)}</p>
            {isCredit && lines.length > 0 ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("balanceLabel")} {money(Math.max(balance, 0))}
              </p>
            ) : null}
            {attempted && blocker ? (
              <p className="text-xs text-destructive" role="alert">
                {blocker}
              </p>
            ) : null}
          </div>
          <Button type="submit" size="lg" className="min-h-12 shrink-0 px-6" disabled={submitting || lines.length === 0}>
            {submitting ? t("recording") : t("record")}
          </Button>
        </div>
      </div>
    </form>
  );
}
