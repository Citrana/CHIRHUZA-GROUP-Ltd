import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { formatMoney } from "../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../convex/lib/time";
import type { PdfDocument, Translate } from "@/lib/pdf/document";

export type StockOverviewForPdf = FunctionReturnType<typeof api.inventory.overview>;
type Holder = StockOverviewForPdf["byHolder"][number]["holder"];
type Product = StockOverviewForPdf["byProduct"][number]["product"];

/**
 * The stock report PDF (drawn by renderPdf): what's held right now and
 * what it's worth - at purchase cost (the Stock page's figure) and at
 * selling prices - by location, by product (with where it is) and by lot.
 * Uses inventory.overview, so own_location viewers only see their own.
 * Money in USD, dates in Lubumbashi time (`t` = "Inventory"). Pure, so
 * it's unit-tested.
 */
export function stockPdfContent(
  overview: StockOverviewForPdf,
  opts: { t: Translate; locale: string; serviceKey: string; serviceName: string; downloadedBy: string; now: number },
): PdfDocument {
  const { t, locale } = opts;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const holderName = (h: Holder) => (h.type === "business" ? t("businessHolder") : h.name);
  const product = (p: Product) =>
    [
      [p.name ?? "-", p.lengthInches !== null ? `${p.lengthInches}"` : null, p.sizeName, p.colourName].filter(Boolean).join(" · "),
      p.sku,
    ]
      .filter(Boolean)
      .join("\n");

  // Valuation: at purchase cost (every lot), and at selling prices (only
  // products that have one; their cost gives the potential margin).
  const units = overview.byProduct.reduce((s, p) => s + p.qty, 0);
  const costValue = overview.byProduct.reduce((s, p) => s + p.value, 0);
  const priced = overview.byProduct.filter((p) => p.product.suggestedPrice !== null);
  const sellingValue = priced.reduce((s, p) => s + p.qty * p.product.suggestedPrice!, 0);
  const pricedCost = priced.reduce((s, p) => s + p.value, 0);
  const unpriced = overview.byProduct.length - priced.length;

  const summary: Array<[string, string]> = [
    [t("pdf.unitsOnHand"), String(units)],
    [t("pdf.productsInStock"), String(overview.byProduct.length)],
    [t("pdf.lots"), String(overview.byLot.length)],
    [t("pdf.costValue"), money(costValue)],
    [
      t("pdf.sellingValue"),
      unpriced > 0 ? `${money(sellingValue)}\n${t("pdf.unpricedNote", { count: unpriced })}` : money(sellingValue),
    ],
    [t("pdf.potentialMargin"), money(sellingValue - pricedCost)],
  ];

  return {
    fileName: `stock-${opts.serviceKey}-${businessDayOf(opts.now)}.pdf`,
    brand: `CHIRHUZA GROUP Ltd · ${opts.serviceName}`,
    title: t("pdf.title"),
    subtitle: [t("pdf.asOf", { date: when.format(opts.now) }), overview.scope === "own_location" ? t("pdf.ownOnly") : null]
      .filter(Boolean)
      .join(" · "),
    sections: [
      { title: t("pdf.summaryTitle"), details: summary },
      { emptyText: t("pdf.costNote") },
      overview.byHolder.length > 0
        ? {
            title: t("pdf.byHolderTitle"),
            table: {
              head: [t("holderHeader"), t("holderTypeHeader"), t("pdf.unitsHeader"), t("pdf.costValueHeader")],
              body: overview.byHolder.map((h) => [
                holderName(h.holder),
                t(`holderTypes.${h.holder.type}`),
                String(h.qty),
                money(h.value),
              ]),
              rightAlign: [2, 3],
              widths: { 1: 28, 2: 22, 3: 34 },
            },
          }
        : { emptyText: t("pdf.empty") },
      ...(overview.byProduct.length > 0
        ? [
            {
              title: t("pdf.byProductTitle"),
              table: {
                head: [
                  t("productHeader"),
                  t("pdf.unitsHeader"),
                  t("pdf.costValueHeader"),
                  t("pdf.sellingValueHeader"),
                  t("whereHeader"),
                ],
                body: overview.byProduct.map((p) => [
                  product(p.product),
                  String(p.qty),
                  money(p.value),
                  p.product.suggestedPrice !== null ? money(p.qty * p.product.suggestedPrice) : "-",
                  p.holders.map((h) => `${holderName(h.holder)}: ${h.qty}`).join("\n"),
                ]),
                rightAlign: [1, 2, 3],
                widths: { 1: 14, 2: 24, 3: 24, 4: 46 },
              },
            },
            {
              title: t("pdf.byLotTitle"),
              table: {
                head: [
                  t("productHeader"),
                  t("lotHeader"),
                  t("pdf.lotDateHeader"),
                  t("unitCostHeader"),
                  t("pdf.unitsHeader"),
                  t("valueHeader"),
                ],
                body: overview.byLot.map((l) => [
                  product(l.product),
                  l.lot.batchNumber ?? "-",
                  day.format(l.lot.createdAt),
                  money(l.lot.unitCost),
                  String(l.qty),
                  money(l.value),
                ]),
                rightAlign: [3, 4, 5],
                widths: { 1: 26, 2: 26, 3: 22, 4: 14, 5: 24 },
              },
            },
          ]
        : []),
    ],
    footer: t("pdf.downloadedBy", { name: opts.downloadedBy, date: when.format(opts.now) }),
  };
}
