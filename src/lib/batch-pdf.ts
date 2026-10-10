import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { formatMoney } from "../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../convex/lib/time";
import type { PdfDocument, PdfSection, Translate } from "@/lib/pdf/document";

export type BatchForPdf = NonNullable<FunctionReturnType<typeof api.stockBatches.get>>;
export type SellingForPdf = NonNullable<FunctionReturnType<typeof api.stockBatches.sellingReport>>;
type Item = BatchForPdf["items"][number];

/**
 * Everything a purchase batch's PDF says (drawn by renderPdf): its status
 * and dates (who bought, approved, received it), the totals, purchased and
 * not-purchased lines, the Goma receiving counts, trip expenses and the
 * requisitions it covers. Money in USD, dates in Lubumbashi time, in the
 * user's language (`t` = "StockBatches", `tRequisitions` = "Requisitions").
 * Pure, so it's unit-tested.
 */
export function batchPdfContent(
  b: BatchForPdf,
  opts: {
    t: Translate;
    tRequisitions: Translate;
    locale: string;
    serviceName: string;
    downloadedBy: string;
    now: number;
    /** The batch's value at selling prices (stockBatches.sellingReport), when loaded. */
    selling?: SellingForPdf;
  },
): PdfDocument {
  const { t, tRequisitions, locale } = opts;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const date = (ms: number) => when.format(ms);
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const product = (item: Item) =>
    [
      [item.productName ?? "-", item.lengthInches !== null ? `${item.lengthInches}"` : null, item.sizeName, item.colourName]
        .filter(Boolean)
        .join(" · "),
      item.sku,
    ]
      .filter(Boolean)
      .join("\n");
  const requisition = (item: Item) => item.requisitionNumber ?? t("extra");

  // Details: status, who bought it, each step's date.
  const details: Array<[string, string]> = [
    [t("pdf.status"), t(`statuses.${b.status}`)],
    [t("pdf.createdBy"), t("pdf.byOn", { name: b.createdByName ?? "-", date: date(b._creationTime) })],
  ];
  if (b.purchasedAt) details.push([t("timeline.purchasedAt"), date(b.purchasedAt)]);
  if (b.approvedAt) {
    const approver = b.approval?.kind === "approve" && b.approval.status === "approved" ? b.approval.decidedByName : null;
    details.push([t("timeline.approvedAt"), approver ? t("pdf.onBy", { date: date(b.approvedAt), name: approver }) : date(b.approvedAt)]);
  }
  if (b.shippedAt) details.push([t("timeline.shippedAt"), date(b.shippedAt)]);
  if (b.arrivedAt) details.push([t("timeline.arrivedAt"), date(b.arrivedAt)]);
  if (b.receivedAt) {
    details.push([
      t("timeline.receivedAt"),
      b.receivedByName ? t("pdf.onBy", { date: date(b.receivedAt), name: b.receivedByName }) : date(b.receivedAt),
    ]);
  }
  if (b.description?.trim()) details.push([t("pdf.description"), b.description.trim()]);
  if (b.approval?.decisionNote) details.push([t("pdf.decisionNote"), b.approval.decisionNote]);

  const purchased = b.items.filter((i) => i.status === "purchased");
  const notPurchased = b.items.filter((i) => i.status === "not_purchased");
  const counting = b.status === "arrived" || b.status === "received";

  const sections: PdfSection[] = [
    { details },
    {
      title: t("pdf.totalsTitle"),
      details: [
        [t("purchasedTotal"), money(b.totals.purchasedTotal)],
        [t("expensesTotal"), money(b.totals.expensesTotal)],
        [t("grandTotal"), money(b.totals.grandTotal)],
      ],
    },
    {
      title: t("pdf.purchasedTitle", { count: purchased.length }),
      ...(purchased.length > 0
        ? {
            table: {
              head: [
                t("pdf.numberHeader"),
                t("pdf.productHeader"),
                t("pdf.requisitionHeader"),
                t("pdf.qtyHeader"),
                t("pdf.unitCostHeader"),
                t("pdf.lineTotalHeader"),
                t("pdf.reasonHeader"),
              ],
              body: purchased.map((item, i) => [
                String(i + 1),
                product(item),
                requisition(item),
                item.requisitionNumber
                  ? t("qtyOfRequested", { purchased: item.qtyPurchased, requested: item.qtyRequested })
                  : String(item.qtyPurchased),
                item.unitCost !== undefined ? money(item.unitCost) : "-",
                item.unitCost !== undefined ? money(item.unitCost * item.qtyPurchased) : "-",
                item.reason ?? "",
              ]),
              rightAlign: [3, 4, 5],
              widths: { 0: 8, 2: 27, 3: 18, 4: 21, 5: 22 },
            },
          }
        : { emptyText: t("pdf.noLines") }),
    },
  ];
  if (notPurchased.length > 0) {
    sections.push({
      title: t("pdf.notPurchasedTitle", { count: notPurchased.length }),
      table: {
        head: [t("pdf.productHeader"), t("pdf.requisitionHeader"), t("pdf.requestedHeader"), t("pdf.reasonHeader")],
        body: notPurchased.map((item) => [product(item), requisition(item), String(item.qtyRequested), item.reason ?? ""]),
        rightAlign: [2],
        widths: { 1: 27, 2: 20 },
      },
    });
  }
  if (counting && purchased.length > 0) {
    sections.push({
      title: t("pdf.receivingTitle"),
      table: {
        head: [
          t("pdf.productHeader"),
          t("pdf.purchasedHeader"),
          t("pdf.receivedHeader"),
          t("pdf.damagedHeader"),
          t("pdf.missingHeader"),
          t("pdf.reasonHeader"),
        ],
        body: purchased.map((item) => [
          product(item),
          String(item.qtyPurchased),
          item.qtyReceived !== undefined ? String(item.qtyReceived) : "-",
          item.qtyDamaged !== undefined ? String(item.qtyDamaged) : "-",
          item.qtyReceived !== undefined ? String(item.missing) : "-",
          item.receiveReason ?? "",
        ]),
        rightAlign: [1, 2, 3, 4],
        widths: { 1: 21, 2: 21, 3: 21, 4: 21 },
      },
    });
  }
  sections.push({
    title: t("pdf.expensesTitle"),
    ...(b.expenses.length > 0
      ? {
          table: {
            head: [t("pdf.categoryHeader"), t("pdf.noteHeader"), t("pdf.amountHeader"), t("pdf.receiptHeader")],
            body: b.expenses.map((e) => [
              t(`categories.${e.category}`),
              e.note ?? "",
              money(e.amount),
              e.receiptFileId ? t("pdf.attached") : "-",
            ]),
            rightAlign: [2],
            widths: { 0: 34, 2: 26, 3: 22 },
          },
        }
      : { emptyText: t("pdf.noExpenses") }),
  });
  // Value at selling prices: expected, sold so far, remaining.
  const selling = opts.selling;
  if (selling && selling.lines.length > 0) {
    const tot = selling.totals;
    const notReceived = t("pdf.sellingNotReceived");
    const amountPcs = (cents: number, qty: number) => `${money(cents)} · ${qty}`;
    // Positive: sold below today's price; negative: above.
    const signed = (cents: number) =>
      cents === 0 ? money(0) : t(cents > 0 ? "pdf.sellingBelow" : "pdf.sellingAbove", { amount: money(Math.abs(cents)) });
    const sellingName = (p: { name: string | null; lengthInches: number | null; sizeName: string | null; colourName: string | null }) =>
      [p.name ?? "-", p.lengthInches !== null ? `${p.lengthInches}"` : null, p.sizeName, p.colourName].filter(Boolean).join(" · ");
    sections.push({
      title: t("pdf.sellingTitle"),
      details: [
        [t("pdf.sellingExpected"), amountPcs(tot.expected, tot.purchased)],
        [t("pdf.sellingSold"), selling.received ? amountPcs(tot.soldAmount, tot.soldQty) : notReceived],
        [t("pdf.sellingRemaining"), selling.received ? amountPcs(tot.remainingValue, tot.remaining) : notReceived],
        ...(selling.received
          ? [
              [t("pdf.sellingDamaged"), amountPcs(tot.damagedValue, tot.damagedOrMissing)] as [string, string],
              [t("pdf.sellingDifferences"), signed(tot.priceDifference)] as [string, string],
            ]
          : []),
      ],
    });
    if (selling.unpriced.length > 0) {
      sections.push({ emptyText: t("pdf.sellingUnpriced", { names: selling.unpriced.map(sellingName).join(", ") }) });
    }
    sections.push({
      table: {
        head: [
          t("pdf.productHeader"),
          t("pdf.purchasedHeader"),
          t("pdf.sellingPriceHeader"),
          t("pdf.sellingExpectedHeader"),
          t("pdf.sellingSoldHeader"),
          t("pdf.sellingRemainingHeader"),
        ],
        body: selling.lines.map((l) => [
          [sellingName(l), l.sku].filter(Boolean).join("\n"),
          String(l.purchased),
          l.price === null ? "-" : money(l.price),
          l.expected === null ? "-" : money(l.expected),
          l.sold === null ? notReceived : amountPcs(l.sold.amount, l.sold.qty),
          l.remaining === null ? notReceived : l.remainingValue === null ? String(l.remaining) : amountPcs(l.remainingValue, l.remaining),
        ]),
        rightAlign: [1, 2, 3, 4, 5],
        widths: { 1: 18, 2: 20, 3: 22, 4: 26, 5: 26 },
      },
    });
    const differing = selling.saleLines.filter((l) => l.difference !== null && l.difference !== 0);
    if (differing.length > 0) {
      const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
      sections.push({
        title: t("pdf.sellingDifferencesTitle"),
        table: {
          head: [
            t("pdf.sellingDateHeader"),
            t("pdf.productHeader"),
            t("pdf.sellingQtyHeader"),
            t("pdf.sellingTodayHeader"),
            t("pdf.sellingSoldForHeader"),
            t("pdf.sellingDifferenceHeader"),
            t("pdf.sellingReasonHeader"),
          ],
          body: differing.map((l) => [
            `${day.format(l.createdAt)}\n${l.saleNumber} · ${l.locationName}`,
            sellingName(l),
            String(l.qty),
            l.todayPrice === null ? "-" : money(l.todayPrice),
            money(l.amount),
            signed(l.difference ?? 0),
            [l.discountReason, l.saleDiscountReason !== null ? t("pdf.sellingWholeSale", { reason: l.saleDiscountReason }) : null]
              .filter(Boolean)
              .join(" · ") || t("pdf.sellingNoReason"),
          ]),
          rightAlign: [2, 3, 4, 5],
          widths: { 2: 12, 3: 20, 4: 20, 5: 24 },
        },
      });
    }
  }

  if (b.requisitions.length > 0) {
    sections.push({
      title: t("pdf.requisitionsTitle"),
      table: {
        head: [t("pdf.requisitionHeader"), t("pdf.locationHeader"), t("pdf.statusHeader")],
        body: b.requisitions.map((r) => [
          r.number ?? "-",
          r.locationName ?? "-",
          r.status ? tRequisitions(`statuses.${r.status}`) : "-",
        ]),
      },
    });
  }

  return {
    fileName: `${b.number}.pdf`,
    brand: `CHIRHUZA GROUP Ltd · ${opts.serviceName}`,
    title: t("pdf.title", { number: b.number }),
    subtitle: b.title,
    sections,
    footer: t("pdf.downloadedBy", { name: opts.downloadedBy, date: date(opts.now) }),
  };
}
