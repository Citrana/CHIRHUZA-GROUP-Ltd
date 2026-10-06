import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { BUSINESS_TIME_ZONE } from "../../convex/lib/time";
import type { PdfDocument, Translate } from "@/lib/pdf/document";

export type RequisitionForPdf = NonNullable<FunctionReturnType<typeof api.requisitions.get>>;

/**
 * Everything a requisition's PDF says (drawn by renderPdf): title, details
 * (status, location, who created / submitted / decided it, when) and one
 * table row per product with how purchasing went. Dates in Lubumbashi
 * time, in the user's language (`t` = the "Requisitions" namespace). Pure,
 * so it's unit-tested.
 */
export function requisitionPdfContent(
  r: RequisitionForPdf,
  opts: { t: Translate; locale: string; serviceName: string; downloadedBy: string; now: number },
): PdfDocument {
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
    ];
  });

  return {
    fileName: `${r.number}.pdf`,
    brand: `CHIRHUZA GROUP Ltd · ${opts.serviceName}`,
    title: t("pdf.title", { number: r.number }),
    sections: [
      { details },
      r.items.length === 0
        ? { emptyText: t("pdf.emptyRequisition") }
        : {
            table: {
              head: [
                t("pdf.numberHeader"),
                t("pdf.productHeader"),
                t("pdf.skuHeader"),
                t("pdf.qtyHeader"),
                t("pdf.lineNoteHeader"),
                t("pdf.purchaseHeader"),
              ],
              body,
              rightAlign: [3],
              widths: { 0: 9, 2: 26, 3: 13, 5: 44 },
            },
          },
    ],
    footer: t("pdf.downloadedBy", { name: opts.downloadedBy, date: date(opts.now) }),
  };
}
