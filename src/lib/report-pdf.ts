import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { formatMoney } from "../../convex/lib/money";
import { percentChange } from "../../convex/lib/analyticsCompare";
import { groupDayRanges, reportHighlights, type Highlight } from "../../convex/lib/reports";
import { BUSINESS_TIME_ZONE } from "../../convex/lib/time";
import type { PdfDocument, PdfSection, PdfTable, Translate } from "@/lib/pdf/document";

export type ReportForView = NonNullable<FunctionReturnType<typeof api.reports.get>>;
export type ReportContentForView = ReportForView["content"];
type StockItem = NonNullable<ReportContentForView["stock"]>["low"][number];
type Product = { name: string; lengthInches: number | null; sizeName: string | null; colourName: string | null };

/** "Bob · 14" · 1B" - the product as shown everywhere (length, size, colour). */
export function stockItemLabel(item: Product, inches: (n: number) => string): string {
  return [item.name, item.lengthInches !== null ? inches(item.lengthInches) : null, item.sizeName, item.colourName]
    .filter(Boolean)
    .join(" · ");
}

/** A day (YYYY-MM-DD) as a readable date. */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** Missing days as ranges: "Nov 10 – Nov 12, 2026, Nov 15, 2026". */
export function formatDayRanges(days: readonly string[], locale: string): string {
  return groupDayRanges(days)
    .map((r) => (r.from === r.to ? formatDay(r.from, locale) : `${formatDay(r.from, locale)} – ${formatDay(r.to, locale)}`))
    .join(", ");
}

/** The highlight lines in words (`t` = "Reports"). */
export function highlightTexts(content: ReportContentForView, t: Translate, locale: string): string[] {
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  return reportHighlights(content).map((h: Highlight) => {
    const values: Record<string, string | number> = { ...h.values };
    if ("amount" in h.values) values.amount = money(h.values.amount);
    return t(`highlights.${h.key}`, values);
  });
}

/** "+12.5%" / "-3%"; null when there's nothing to compare. */
export function changeText(current: number, previous: number | null | undefined): string | null {
  const pct = percentChange(current, previous);
  return pct === null ? null : `${pct > 0 ? "+" : ""}${pct}%`;
}

/**
 * A saved report as a PDF (drawn by renderPdf): highlights first, then the
 * same sections as the page, in plain words. Each section is kept on one
 * page when it fits. Money in USD, dates in Lubumbashi time.
 * `t` = "Reports". Pure, so it's tested.
 */
export function reportPdfContent(
  report: ReportForView,
  opts: {
    t: Translate;
    tApprovalType: (type: string) => string;
    inches: (n: number) => string;
    locale: string;
    serviceKey: string;
    serviceName: string;
    downloadedBy: string;
    now: number;
  },
): PdfDocument {
  const { t, locale } = opts;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const money = (cents: number, currency: "USD" | "CDF" = "USD") => formatMoney(cents, currency, locale);
  const day = (d: string) => formatDay(d, locale);
  const c = report.content;
  const sections: PdfSection[] = [
    {
      details: [
        [t("pdf.period"), `${day(report.from)} - ${day(report.to)}`],
        [t("pdf.type"), t(`kinds.${report.kind}`)],
        [t("pdf.madeBy"), report.createdByName],
      ],
    },
  ];

  if (report.status === "failed") {
    sections.push({ title: t("failedTitle"), emptyText: t("failedBody") });
  }

  const highlights = highlightTexts(c, t, locale);
  if (highlights.length > 0) sections.push({ title: t("highlights.title"), highlights, keepTogether: true });

  if (c.sales) {
    const f = c.sales.figures;
    const prev = c.sales.previous ?? null;
    const understated =
      (c.sales.missingDaysCount ?? 0) > 0 ? t("sales.understated", { count: c.sales.missingDaysCount ?? 0 }) : undefined;
    if (f) {
      const rows: Array<[string, number, number | null]> = [
        [t("sales.total"), f.sales, prev?.sales ?? null],
        [t("sales.margin"), f.margin, prev?.margin ?? null],
        [t("sales.expenses"), f.expenses, prev?.expenses ?? null],
        [t("sales.payroll"), f.payroll, prev?.payroll ?? null],
        [t("sales.netProfit"), f.netProfit, prev?.netProfit ?? null],
        [t("sales.withdrawals"), f.withdrawals, prev?.withdrawals ?? null],
      ];
      sections.push({
        title: t("sections.sales"),
        table: {
          head: prev
            ? ["", t("sales.thisPeriod"), t("sales.previousPeriod"), t("sales.change")]
            : ["", t("sales.thisPeriod")],
          body: rows.map(([label, now, before]) =>
            prev ? [label, money(now), money(before ?? 0), changeText(now, before) ?? "-"] : [label, money(now)],
          ),
          rightAlign: prev ? [1, 2, 3] : [1],
          widths: prev ? { 1: 34, 2: 34, 3: 22 } : { 1: 40 },
        },
        emptyText: [
          prev && c.sales.compareFrom && c.sales.compareTo
            ? t("sales.comparedWith", { from: day(c.sales.compareFrom), to: day(c.sales.compareTo) })
            : null,
          t("sales.withdrawalsNote"),
          understated ?? null,
        ]
          .filter(Boolean)
          .join(" "),
        keepTogether: true,
      });
    } else {
      // A report saved before the detailed figures existed.
      const details: Array<[string, string]> = [[t("sales.total"), money(c.sales.total)]];
      if (c.sales.compareFrom && c.sales.compareTo && c.sales.previousTotal !== null) {
        details.push([t("sales.previous", { from: day(c.sales.compareFrom), to: day(c.sales.compareTo) }), money(c.sales.previousTotal)]);
        details.push([t("sales.change"), changeText(c.sales.total, c.sales.previousTotal) ?? t("sales.noPrevious")]);
      }
      sections.push({ title: t("sections.sales"), details, keepTogether: true });
    }
    if (c.sales.byShop && c.sales.byShop.length > 0) {
      sections.push({
        title: t("sales.byShop"),
        table: { head: ["", t("sales.revenue")], body: c.sales.byShop.map((s) => [s.name, money(s.sales)]), rightAlign: [1], widths: { 1: 40 } },
        keepTogether: true,
      });
    }
    if (c.sales.topProducts) {
      sections.push(
        c.sales.topProducts.length === 0
          ? { title: t("sales.topProducts"), emptyText: t("sales.noTopProducts") }
          : {
              title: t("sales.topProducts"),
              table: {
                head: [t("stock.product"), t("sales.units"), t("sales.revenue"), t("sales.margin")],
                body: c.sales.topProducts.map((p) => [stockItemLabel(p, opts.inches), String(p.unitsSold), money(p.revenue), money(p.margin)]),
                rightAlign: [1, 2, 3],
                widths: { 1: 18, 2: 30, 3: 30 },
              },
              keepTogether: true,
            },
      );
    }
  }

  if (c.missingDays) {
    const truncated = c.missingDays.shops.some((s) => s.truncated);
    sections.push(
      c.missingDays.count === 0
        ? { title: t("sections.missingDays"), emptyText: t("missing.none") }
        : {
            title: t("missing.count", { count: c.missingDays.count }),
            details: c.missingDays.shops.map(
              (s) => [`${s.name}\n${t("missing.shopCount", { count: s.count ?? s.days.length })}`, formatDayRanges(s.days, locale)] as [string, string],
            ),
            emptyText: [truncated ? t("missing.latest", { count: 14 }) : null, t("missing.hint")].filter(Boolean).join(" "),
            keepTogether: true,
          },
    );
  }

  if (c.stock) {
    const hasReorder = [...c.stock.low, ...c.stock.out].some((i) => i.reorderQty !== undefined);
    const table = (items: StockItem[], out: boolean): PdfTable => ({
      head: [
        t("stock.product"),
        out ? t("stock.outSince") : t("stock.onHand"),
        ...(hasReorder ? [t("stock.sold30"), t("stock.reorder")] : []),
      ],
      body: items.map((i) => [
        `${stockItemLabel(i, opts.inches)}\n${i.sku}`,
        out ? (i.outOfStockSince !== null ? date.format(i.outOfStockSince) : "-") : String(i.onHand),
        ...(hasReorder ? [String(i.sold30 ?? 0), String(i.reorderQty ?? 0)] : []),
      ]),
      rightAlign: out ? [2, 3] : [1, 2, 3],
      widths: hasReorder ? { 1: 30, 2: 26, 3: 26 } : { 1: 40 },
    });
    const details: Array<[string, string]> = [
      [t("stock.lowCount"), String(c.stock.lowCount)],
      [t("stock.outCount"), String(c.stock.outCount)],
    ];
    if (c.stock.value !== undefined) details.push([t("stock.value"), money(c.stock.value)]);
    if (c.stock.unitsOnHand !== undefined) details.push([t("stock.units"), String(c.stock.unitsOnHand)]);
    sections.push({
      title: t("sections.stock"),
      details,
      emptyText: c.stock.lowCount + c.stock.outCount === 0 ? t("stock.none") : hasReorder ? t("stock.reorderHint") : undefined,
      keepTogether: true,
    });
    if (c.stock.low.length > 0) sections.push({ title: t("stock.lowCount"), table: table(c.stock.low, false), keepTogether: true });
    if (c.stock.out.length > 0) sections.push({ title: t("stock.outCount"), table: table(c.stock.out, true), keepTogether: true });
  }

  if (c.approvals) {
    const items = c.approvals.items;
    if (c.approvals.count === 0) {
      sections.push({ title: t("sections.approvals"), emptyText: t("approvals.none") });
    } else if (items) {
      sections.push({
        title: `${t("sections.approvals")} (${c.approvals.count})`,
        table: {
          head: [t("approvals.type"), t("approvals.amount"), t("approvals.requestedBy"), t("approvals.requestedOn")],
          body: items.map((a) => [
            opts.tApprovalType(a.type),
            a.amount !== null ? money(a.amount, a.currency ?? "USD") : "-",
            a.requestedByName,
            date.format(a.requestedAt),
          ]),
          rightAlign: [1],
          widths: { 1: 30, 2: 40, 3: 28 },
        },
        emptyText: c.approvals.count > items.length ? t("approvals.more", { shown: items.length, total: c.approvals.count }) : undefined,
        keepTogether: true,
      });
    } else {
      sections.push({
        title: `${t("sections.approvals")} (${c.approvals.count})`,
        details: c.approvals.byType.map((a) => [opts.tApprovalType(a.type), String(a.count)] as [string, string]),
      });
    }
  }

  if (c.credit) {
    const detailed = c.credit.top.some((x) => x.oldestUnpaidAt !== undefined);
    sections.push(
      c.credit.customers === 0
        ? { title: t("sections.credit"), emptyText: t("credit.none") }
        : {
            title: t("sections.credit"),
            details: [[t("credit.total"), `${money(c.credit.totalOwed)} (${t("credit.customers", { count: c.credit.customers })})`]],
            table: {
              head: detailed
                ? [t("credit.customer"), t("credit.owed"), t("credit.oldest"), t("credit.daysUnpaid")]
                : [t("credit.customer"), t("credit.owed")],
              body: c.credit.top.map((x) =>
                detailed
                  ? [x.name, money(x.balance), x.oldestUnpaidAt !== undefined ? date.format(x.oldestUnpaidAt) : "-", t("credit.days", { count: x.daysUnpaid ?? 0 })]
                  : [x.name, money(x.balance)],
              ),
              rightAlign: detailed ? [1, 3] : [1],
              widths: detailed ? { 1: 30, 2: 32, 3: 26 } : { 1: 40 },
            },
            emptyText: [
              detailed ? t("credit.sortNote") : null,
              c.credit.customers > c.credit.top.length ? t("credit.more", { shown: c.credit.top.length, total: c.credit.customers }) : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined,
            keepTogether: true,
          },
    );
  }

  if (c.cash) {
    sections.push({
      title: t("sections.cash"),
      details: [
        [t("cash.onHand"), money(c.cash.onHand)],
        [t("cash.pending"), `${money(c.cash.pendingOpeningCash)} (${t("cash.pendingCount", { count: c.cash.pendingOpeningCashCount })})`],
      ],
      emptyText: t("cash.hint"),
      keepTogether: true,
    });
  }

  sections.push({ emptyText: t("asOfNote") });

  return {
    fileName: `report-${opts.serviceKey}-${report.from}_${report.to}.pdf`,
    brand: `CHIRHUZA GROUP Ltd · ${opts.serviceName}`,
    title: t("reportTitle", { from: day(report.from), to: day(report.to) }),
    subtitle: t("basedOn", { date: when.format(report.generatedAt) }),
    sections,
    footer: t("pdf.downloadedBy", { name: opts.downloadedBy, date: when.format(opts.now) }),
  };
}
