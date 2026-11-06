"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CheckCircle2, History } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { MAX_BACKDATE_DAYS, PAYMENT_METHODS, type PaymentMethod } from "../../../convex/lib/sales";
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
import { CustomerPicker, type PickedCustomer } from "@/components/sales/customer-picker";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { type CelebrationTier, firstName, nextQuote, tierFor } from "@/lib/sale-celebration";
import { isEmptyDraft, parseDraft, saleDraftKey, serializeDraft, type SaleDraft } from "@/lib/sale-draft";
import { SaleCelebration } from "./sale-celebration";
import { SalePreviewDialog, type SalePreview } from "./sale-preview-dialog";
import {
  ProductLineCard,
  ProductSearchResults,
  groupLots,
  lotLines,
  matchProducts,
  productLabel,
  productLineProblems,
  type ProductLine,
} from "./product-lines";

type Line = ProductLine;

const LOCATION_KEY = "sale-location";

function rememberedLocation(): string {
  try {
    return localStorage.getItem(LOCATION_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The saved unfinished sale for this user and service, if any. */
function loadDraft(key: string): SaleDraft | null {
  const today = businessDayOf(Date.now());
  try {
    return parseDraft(localStorage.getItem(key), { today, earliest: addBusinessDays(today, -MAX_BACKDATE_DAYS) });
  } catch {
    return null;
  }
}

/**
 * The phone sale form: where (locked to the seller's own location for
 * own_location sellers), what (search products in stock there, quantity
 * and price - the units come from the product's lots there, oldest
 * first), how it's paid. The server re-checks
 * everything and refuses to sell stock that isn't there.
 */
export function SaleForm({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Sales");
  const canSell = useCan("sales.create");
  const me = useQuery(api.users.getCurrentUser, canSell ? {} : "skip");
  if (canSell === undefined) return null;
  if (!canSell) return <p className="text-sm text-muted-foreground">{t("cannotSell")}</p>;
  if (!me) return null;
  return <SaleFormBody key={me._id} service={service} userId={me._id} userName={me.name} />;
}

/**
 * The form itself, for a seller. The unfinished sale is saved in the
 * browser as a draft (per user and service) while it's being filled in,
 * so leaving the page doesn't lose it; recording or discarding clears it.
 */
function SaleFormBody({ service, userId, userName }: { service: BusinessUnitKey; userId: string; userName?: string }) {
  const t = useTranslations("Sales");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const draftKey = saleDraftKey(userId, service);
  // Read once, on the first render: the initial state below comes from it.
  const [draft] = useState(() => loadDraft(draftKey));
  const [restored, setRestored] = useState(() => draft !== null && !isEmptyDraft(draft));
  const [picked, setPicked] = useState(() => draft?.locationId || rememberedLocation());
  const options = useQuery(api.sales.options, {
    businessUnitKey: service,
    ...(picked ? { locationId: picked as Id<"locations"> } : {}),
  });
  const create = useMutation(api.sales.create);
  const [lines, setLines] = useState<Line[]>(() => draft?.lines ?? []);
  const [nextKey, setNextKey] = useState(() => Math.max(0, ...(draft?.lines ?? []).map((l) => l.key)) + 1);
  const [search, setSearch] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>(() => draft?.payment ?? "cash");
  // Optional name on a cash / mobile money sale.
  const [customer, setCustomer] = useState(() => draft?.customer ?? "");
  // Credit: the customer from the customer list, what they paid now and how.
  const [creditCustomer, setCreditCustomer] = useState<PickedCustomer | null>(() => draft?.creditCustomer ?? null);
  const [paidNow, setPaidNow] = useState<number | null>(() => (draft ? draft.paidNow : 0));
  const [paidNowMethod, setPaidNowMethod] = useState<CollectionMethod>(() => draft?.paidNowMethod ?? "cash");
  // The agreed total, for the lines' total it was entered against: when the
  // lines change, it goes back to following their total. Lower than the
  // lines is a whole-sale discount and needs a reason.
  const [agreed, setAgreed] = useState<{ value: number; linesTotal: number } | null>(() => draft?.agreed ?? null);
  const [saleReason, setSaleReason] = useState(() => draft?.saleReason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    number: string;
    total: number;
    soldOn: string;
    credit?: { customer: string; balance: number };
  } | null>(null);
  // The mascot after each sale: the shop's products that day, its gift and a quote.
  const [celebration, setCelebration] = useState<{
    key: string;
    units: number;
    location: string;
    soldOn: string;
    tier: CelebrationTier;
    quote: number;
  } | null>(null);
  const [lastQuote, setLastQuote] = useState<number | null>(null);
  // The day of the sale: today, or up to MAX_BACKDATE_DAYS back for a sale
  // recorded late. Kept after recording, to enter several late sales.
  const [today, setToday] = useState(() => businessDayOf(Date.now()));
  const [soldOn, setSoldOn] = useState(() => draft?.soldOn ?? today);
  const [submitting, setSubmitting] = useState(false);
  // The preview shown before recording, to catch mistakes.
  const [reviewing, setReviewing] = useState(false);
  // Problems are only highlighted once the seller has tried to record.
  const [attempted, setAttempted] = useState(false);
  const resolvedLocation = options?.locationId ?? null;

  // A restored draft from another location than the one the seller now
  // sells at (e.g. their own location changed): its lines don't apply here.
  // Checked once, as soon as the server says where the seller sells.
  const [draftChecked, setDraftChecked] = useState(() => !draft || draft.lines.length === 0);
  if (!draftChecked && options !== undefined) {
    setDraftChecked(true);
    if (resolvedLocation !== draft?.locationId) setLines([]);
  }

  // Keep the draft in step with the form; an untouched form leaves nothing behind.
  useEffect(() => {
    const current: SaleDraft = {
      locationId: resolvedLocation ?? picked,
      lines,
      payment,
      customer,
      creditCustomer,
      paidNow,
      paidNowMethod,
      agreed,
      saleReason,
      soldOn,
    };
    try {
      if (isEmptyDraft(current)) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, serializeDraft(current));
    } catch {
      // The draft is only a convenience.
    }
  }, [draftKey, resolvedLocation, picked, lines, payment, customer, creditCustomer, paidNow, paidNowMethod, agreed, saleReason, soldOn]);

  const inches = (n: number) => tProducts("inches", { inches: n });
  // Mode products have a photo: show it so sellers pick the right item.
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const earliest = addBusinessDays(today, -MAX_BACKDATE_DAYS);
  const longDay = (day: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: BUSINESS_TIME_ZONE }).format(
      businessDayStartUtc(day) + 12 * 3600_000,
    );
  const lots = options?.lots ?? [];
  const locationId = options?.locationId ?? null;

  // Products in stock here, for the search list and the lines.
  const products = groupLots(lots);
  const term = search.trim();
  const matches = matchProducts(products, search);
  const problemsOf = (line: Line) => productLineProblems(line, products.get(line.productId));
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
      update(existing.key, { qty: Math.min(existing.qty + 1, entry.onHand) });
    } else {
      setLines((prev) => [
        ...prev,
        { key: nextKey, productId, qty: 1, price: entry.first.suggestedPrice ?? null, reason: "" },
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

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocker || !locationId) {
      setAttempted(true);
      return;
    }
    setError(null);
    setReviewing(true);
  }

  /** Back to an empty form (after recording, or when the draft is discarded). */
  function resetForm() {
    setLines([]);
    setCustomer("");
    setCreditCustomer(null);
    setPaidNow(0);
    setPaidNowMethod("cash");
    setAgreed(null);
    setSaleReason("");
    setPayment("cash");
    setAttempted(false);
    setRestored(false);
  }

  function discardDraft() {
    resetForm();
    setSearch("");
    setSoldOn(today);
    setDone(null);
  }

  async function recordSale() {
    if (blocker || !locationId) return;
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
        // One server line per lot the units come from, so each keeps its own cost.
        lines: lines.flatMap((l) => lotLines(l, products.get(l.productId))),
      });
      setReviewing(false);
      setDone({
        number: result.number,
        total,
        soldOn: result.soldOn,
        ...(isCredit && creditCustomer ? { credit: { customer: creditCustomer.name, balance } } : {}),
      });
      const quote = nextQuote(lastQuote);
      setLastQuote(quote);
      setCelebration({
        key: result.number,
        units: result.dayUnits,
        location: options?.locations.find((l) => l._id === locationId)?.name ?? "",
        soldOn: result.soldOn,
        tier: tierFor(result.dayUnits),
        quote,
      });
      // The form may stay open past midnight: "today" per the server.
      setToday(result.recordedOn);
      resetForm();
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string } | string) : null;
      setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  const preview: SalePreview | null = reviewing
    ? {
        date: longDay(soldOn),
        backdated: soldOn !== today,
        location: options?.locations.find((l) => l._id === locationId)?.name ?? "",
        lines: lines.map((l) => {
          const lot = products.get(l.productId)?.first;
          return {
            key: l.key,
            label: lot ? productLabel(lot, inches) : t("goneLine"),
            photoUrl: lot?.photoUrl,
            qtyAtPrice: t("qtyAtPrice", { qty: l.qty, price: money(l.price ?? 0) }),
            total: money((l.price ?? 0) * l.qty),
            reason: l.reason.trim() || null,
          };
        }),
        linesTotal: money(linesTotal),
        total: money(total),
        saleDiscountReason: discounted ? saleReason.trim() : null,
        payment: t(`payments.${payment}`),
        customer: isCredit ? (creditCustomer?.name ?? null) : customer.trim() || null,
        credit: isCredit
          ? {
              paidNow: money(paidNow ?? 0),
              paidWith: (paidNow ?? 0) > 0 ? t(`payments.${paidNowMethod}`) : null,
              balance: money(Math.max(balance, 0)),
            }
          : null,
      }
    : null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 pb-28">
      {preview ? (
        <SalePreviewDialog
          open
          preview={preview}
          withPhotos={withPhotos}
          submitting={submitting}
          blocker={blocker}
          error={error}
          onCorrect={() => setReviewing(false)}
          onConfirm={recordSale}
        />
      ) : null}
      {celebration ? (
        <SaleCelebration
          key={celebration.key}
          name={firstName(userName)}
          units={celebration.units}
          location={celebration.location}
          date={celebration.soldOn === today ? null : longDay(celebration.soldOn)}
          tier={celebration.tier}
          quote={celebration.quote}
          onDone={() => setCelebration(null)}
        />
      ) : null}
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

      {restored ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <History className="size-5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">{t("draftRestored")}</span>
          <Button type="button" variant="outline" className="min-h-11" onClick={discardDraft}>
            {t("discardDraft")}
          </Button>
        </div>
      ) : null}

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
            <ProductSearchResults matches={matches} withPhotos={withPhotos} onPick={addProduct} />
          ) : lots.length === 0 && options ? (
            <p className="text-sm text-muted-foreground">{t("noStockHere")}</p>
          ) : null}
        </div>
      ) : null}

      {lines.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label={t("linesLabel")}>
          {lines.map((line) => (
            <ProductLineCard
              key={line.key}
              service={service}
              line={line}
              entry={products.get(line.productId)}
              attempted={attempted}
              withPhotos={withPhotos}
              onChange={(patch) => update(line.key, patch)}
              onRemove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
            />
          ))}
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

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur md:sticky md:-mx-4">
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
