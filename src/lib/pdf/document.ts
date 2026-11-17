/**
 * The shared PDF builder for documents users download (requisitions,
 * purchase batches, ...). Each document only describes its content as a
 * PdfDocument (plain strings); renderPdf draws it on A4 in the browser
 * and saves it. Nothing is stored or sent anywhere.
 */

/** next-intl's `t` for one namespace (keys like "pdf.title"). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export type PdfTable = {
  head: string[];
  body: string[][];
  /** Column indexes to right-align (quantities, money). */
  rightAlign?: number[];
  /** Fixed column widths in mm, by column index. */
  widths?: Record<number, number>;
};

/** One block of the document: a title, then details, a table or a line of text. */
export type PdfSection = {
  title?: string;
  /** Short lines in a shaded box (a report's highlights), drawn before the rest. */
  highlights?: string[];
  details?: Array<[label: string, value: string]>;
  table?: PdfTable;
  emptyText?: string;
  /**
   * Keep the section on one page when it fits on a fresh one: it starts a
   * new page instead of splitting, and table rows never break across
   * pages. Opt-in; other documents keep their flow.
   */
  keepTogether?: boolean;
};

const ROW_MM = 6.5;
const LINE_MM = 4.2;

/** A rough height (mm) of a section, to decide whether it fits on the page. */
export function estimateSectionHeight(section: PdfSection): number {
  const lines = (text: string) => text.split("\n").length;
  let h = section.title ? 8 : 0;
  if (section.highlights) h += 10 + section.highlights.length * 2 * LINE_MM;
  if (section.details) h += section.details.reduce((t, [l, v]) => t + Math.max(lines(l), lines(v)) * LINE_MM + 2.4, 0) + 6;
  if (section.table && section.table.body.length > 0) {
    h += ROW_MM + 4 + section.table.body.reduce((t, row) => t + Math.max(...row.map(lines)) * LINE_MM + 2.6, 0);
  }
  if (section.emptyText) h += 2 * LINE_MM + 4;
  return h;
}

export type PdfDocument = {
  fileName: string;
  /** "CHIRHUZA GROUP Ltd · Hair". */
  brand: string;
  title: string;
  subtitle?: string;
  sections: PdfSection[];
  /** "Downloaded by ... on ...", on every page. */
  footer: string;
};

/**
 * The standard PDF fonts only cover Latin-1: keep accents (é, à, ç...) and
 * the middle dot, swap typographic characters outside it.
 */
export function pdfSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    // Browsers put thin no-break spaces in dates and money ("10:15 AM", "3 987,00 $").
    .replace(/[\u202F\u2009\u200A\u2007]/g, " ")
    .replace(/\u2032/g, "'")
    .replace(/[^\x00-\xFF]/g, "?");
}

const INK: [number, number, number] = [26, 46, 34];
const MUTED: [number, number, number] = [91, 107, 96];
const MARGIN = 16;

/**
 * Draws the document on A4 and saves it. jsPDF is loaded only now, so the
 * pages themselves stay light.
 */
export async function renderPdf(document: PdfDocument, pageLabel: (page: number, pages: number) => string) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(pdfSafe(document.brand), MARGIN, 18);
  doc.setFontSize(18);
  doc.setTextColor(...INK);
  doc.text(pdfSafe(document.title), MARGIN, 28);
  let y = 28;
  if (document.subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...MUTED);
    doc.text(pdfSafe(document.subtitle), MARGIN, 34);
    y = 34;
  }
  doc.setDrawColor(200, 230, 160);
  doc.setLineWidth(1);
  doc.line(MARGIN, y + 4, width - MARGIN, y + 4);
  y += 8;

  const ensureRoom = (needed: number) => {
    if (y + needed > height - 20) {
      doc.addPage();
      y = 18;
    }
  };

  const room = height - 20;
  for (const section of document.sections) {
    if (section.keepTogether) {
      const needed = estimateSectionHeight(section);
      // Start a new page when it doesn't fit here but would on its own page,
      // or when it's longer than a page and little room is left (so a long
      // table doesn't start with a few rows at the bottom).
      if ((y + needed > room && needed <= room - 18) || (needed > room - 18 && room - y < 80)) {
        doc.addPage();
        y = 18;
      }
    }
    if (section.title) {
      ensureRoom(14);
      y += 4;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...INK);
      doc.text(pdfSafe(section.title), MARGIN, y);
      y += 2;
    }
    if (section.highlights && section.highlights.length > 0) {
      const inner = width - MARGIN * 2 - 8;
      const lines = section.highlights.flatMap((h) => doc.splitTextToSize(`- ${pdfSafe(h)}`, inner) as string[]);
      const boxHeight = lines.length * 4.2 + 6;
      ensureRoom(boxHeight + 4);
      doc.setFillColor(237, 246, 226);
      doc.setDrawColor(200, 230, 160);
      doc.setLineWidth(0.4);
      doc.roundedRect(MARGIN, y + 1, width - MARGIN * 2, boxHeight, 2, 2, "FD");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...INK);
      doc.text(lines, MARGIN + 4, y + 6);
      y += boxHeight + 5;
    }
    if (section.details) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN, bottom: 20 },
        theme: "plain",
        styles: { font: "helvetica", fontSize: 10, cellPadding: { top: 1.2, bottom: 1.2, left: 0, right: 4 }, textColor: INK },
        columnStyles: { 0: { fontStyle: "bold", cellWidth: 44, textColor: MUTED } },
        body: section.details.map(([label, value]) => [pdfSafe(label), pdfSafe(value)]),
      });
      y = lastY() + 6;
    }
    if (section.table && section.table.body.length > 0) {
      const columnStyles: Record<number, { cellWidth?: number; halign?: "right" }> = {};
      for (const [index, cellWidth] of Object.entries(section.table.widths ?? {})) {
        columnStyles[Number(index)] = { ...columnStyles[Number(index)], cellWidth };
      }
      for (const index of section.table.rightAlign ?? []) {
        columnStyles[index] = { ...columnStyles[index], halign: "right" };
      }
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN, bottom: 20 },
        theme: "grid",
        head: [section.table.head.map(pdfSafe)],
        body: section.table.body.map((row) => row.map(pdfSafe)),
        styles: { font: "helvetica", fontSize: 9, cellPadding: 2, textColor: INK, lineColor: [211, 223, 207], valign: "top" },
        headStyles: { fillColor: INK, textColor: [245, 248, 242], fontStyle: "bold" },
        alternateRowStyles: { fillColor: [247, 250, 244] },
        columnStyles,
        ...(section.keepTogether ? { rowPageBreak: "avoid" as const, showHead: "everyPage" as const } : {}),
      });
      y = lastY() + 4;
    }
    if (section.emptyText) {
      const lines = doc.splitTextToSize(pdfSafe(section.emptyText), width - MARGIN * 2) as string[];
      ensureRoom(lines.length * 5 + 2);
      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.setTextColor(...MUTED);
      doc.text(lines, MARGIN, y + 4);
      y += lines.length * 5 + 4;
    }
  }

  // Footer on every page: who downloaded it, when, and the page number.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(pdfSafe(document.footer), MARGIN, height - 10);
    doc.text(pdfSafe(pageLabel(page, pages)), width - MARGIN, height - 10, { align: "right" });
  }
  doc.save(document.fileName);
}
