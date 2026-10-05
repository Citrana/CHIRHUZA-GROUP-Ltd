import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { BUSINESS_TIME_ZONE } from "../../convex/lib/time";

export type RequisitionForPdf = NonNullable<FunctionReturnType<typeof api.requisitions.get>>;

/** next-intl's `t` for the "Requisitions" namespace (keys like "pdf.title"). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export type RequisitionPdfContent = {
  fileName: string;
  brand: string;
  title: string;
  details: Array<[label: string, value: string]>;
  head: string[];
  body: string[][];
  emptyText: string | null;
  footer: string;
};

/**
 * The standard PDF fonts only cover Latin-1: keep accents (é, à, ç…) and
 * the middle dot, swap typographic characters outside it.
 */
export function pdfSafe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    // Browsers put thin no-break spaces in dates ("10:15 AM", "3 oct.").
    .replace(/[    ]/g, " ")
    .replace(/′/g, "'")
    .replace(/[^\x00-\xFF]/g, "?");
}

/**
 * Everything a requisition's PDF says, as plain strings: title, details
 * (status, location, who created / submitted / decided it, when) and one
 * table row per product with how purchasing went. Dates in Lubumbashi
 * time, in the user's language. Pure, so it's unit-tested.
 */
export function requisitionPdfContent(
  r: RequisitionForPdf,
  opts: { t: Translate; locale: string; serviceName: string; downloadedBy: string; now: number },
): RequisitionPdfContent {
  const { t, locale } = opts;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const date = (ms: number) => when.format(ms);

  const details: Array<[string, string]> = [
    [t("pdf.status"), t(`statuses.${r.status}`)],
    [t("pdf.location"), r.locationName ?? "-"],
    [t("pdf.createdBy"), t("pdf.createdByValue", { name: r.createdByName ?? "-", date: date(r._creationTime) })],
    [t("pdf.submitted"), r.submittedAt ? date(r.submittedAt) : t("pdf.notSubmitted")],
  ];
  if (r.approval) {
    const by = { name: r.approval.decidedByName ?? "-", date: r.approval.decidedAt ? date(r.approval.decidedAt) : "-" };
    details.push([
      t("pdf.decision"),
      r.approval.status === "approved"
        ? t("pdf.approvedBy", by)
        : r.approval.status === "rejected"
          ? t("pdf.rejectedBy", by)
          : t("pdf.pendingDecision"),
    ]);
    if (r.approval.decisionNote) details.push([t("pdf.decisionNote"), r.approval.decisionNote]);
  }
  if (r.note?.trim()) details.push([t("pdf.note"), r.note.trim()]);

  const body = r.items.map((item, i) => {
    const product = [item.productName ?? "-", item.lengthInches !== null ? `${item.lengthInches}"` : null, item.sizeName, item.colourName]
      .filter(Boolean)
      .join(" · ");
    const purchase = [
      t(`resolutions.${item.resolution}`),
      ...item.purchases.map((p) => {
        const batch = p.batchNumber ?? "-";
        const line = p.status === "purchased" ? t("pdf.boughtIn", { qty: p.qtyPurchased, batch }) : t("pdf.notBoughtIn", { batch });
        return p.reason ? `${line} (${p.reason})` : line;
      }),
    ].join("\n");
    return [
      String(i + 1),
      item.addedByBuyer ? `${product}\n${t("pdf.addedByBuyer")}` : product,
      item.sku ?? "-",
      String(item.qtyRequested),
      item.note ?? "",
      purchase,
    ].map(pdfSafe);
  });

  return {
    fileName: `${r.number}.pdf`,
    brand: pdfSafe(`CHIRHUZA GROUP Ltd · ${opts.serviceName}`),
    title: pdfSafe(t("pdf.title", { number: r.number })),
    details: details.map(([label, value]) => [pdfSafe(label), pdfSafe(value)]),
    head: [
      t("pdf.numberHeader"),
      t("pdf.productHeader"),
      t("pdf.skuHeader"),
      t("pdf.qtyHeader"),
      t("pdf.lineNoteHeader"),
      t("pdf.purchaseHeader"),
    ].map(pdfSafe),
    body,
    emptyText: r.items.length === 0 ? pdfSafe(t("pdf.emptyRequisition")) : null,
    footer: pdfSafe(t("pdf.downloadedBy", { name: opts.downloadedBy, date: date(opts.now) })),
  };
}

const INK: [number, number, number] = [26, 46, 34];
const MUTED: [number, number, number] = [91, 107, 96];

/**
 * Draws the requisition on A4 and saves it. jsPDF is loaded only now, so
 * the page itself stays light.
 */
export async function downloadRequisitionPdf(content: RequisitionPdfContent, pageLabel: (page: number, pages: number) => string) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 16;
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(content.brand, margin, 18);
  doc.setFontSize(18);
  doc.setTextColor(...INK);
  doc.text(content.title, margin, 28);
  doc.setDrawColor(200, 230, 160);
  doc.setLineWidth(1);
  doc.line(margin, 32, width - margin, 32);

  autoTable(doc, {
    startY: 36,
    margin: { left: margin, right: margin, bottom: 20 },
    theme: "plain",
    styles: { font: "helvetica", fontSize: 10, cellPadding: { top: 1.2, bottom: 1.2, left: 0, right: 4 }, textColor: INK },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 42, textColor: MUTED } },
    body: content.details,
  });

  const after = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  if (content.emptyText) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(content.emptyText, width - margin * 2), margin, after + 4);
  }
  if (content.body.length > 0) {
    autoTable(doc, {
      startY: after,
      margin: { left: margin, right: margin, bottom: 20 },
      theme: "grid",
      head: [content.head],
      body: content.body,
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2, textColor: INK, lineColor: [211, 223, 207], valign: "top" },
      headStyles: { fillColor: INK, textColor: [245, 248, 242], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [247, 250, 244] },
      columnStyles: { 0: { cellWidth: 9 }, 2: { cellWidth: 26 }, 3: { cellWidth: 13, halign: "right" }, 5: { cellWidth: 44 } },
    });
  }

  // Footer on every page: who downloaded it, when, and the page number.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(content.footer, margin, height - 10);
    doc.text(pdfSafe(pageLabel(page, pages)), width - margin, height - 10, { align: "right" });
  }
  doc.save(content.fileName);
}
