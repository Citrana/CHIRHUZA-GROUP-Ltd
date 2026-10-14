import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { formatMoney } from "../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayStartUtc } from "../../convex/lib/time";
import { COMPANY } from "./company";
import { pdfSafe, type Translate } from "./pdf/document";

export type ContractForPaper = NonNullable<FunctionReturnType<typeof api.contracts.get>>;

/** One labelled line on the paper. */
export type PaperRow = [label: string, value: string];

/**
 * Everything a transport contract's paper says - drawn on screen by
 * ContractPaper and in the PDF by renderContractPdf, so both always match.
 * The client's copy: driver pay never appears. Money in USD, dates in
 * Lubumbashi time, in the user's language (`t` = "Contracts"). Pure, so
 * it's unit-tested.
 */
export type ContractPaperContent = {
  fileName: string;
  company: { name: string; details: string[] };
  title: string;
  kicker: string;
  number: string;
  seal: { ring: string; number: string; date: string };
  parties: Array<{ heading: string; name: string; lines: string[] }>;
  vehicle: { title: string; rows: PaperRow[] };
  period: { title: string; rows: PaperRow[] };
  price: { title: string; rows: PaperRow[]; total: PaperRow; reason: string | null };
  payments: {
    title: string;
    head: [string, string, string];
    rows: Array<[date: string, method: string, amount: string]>;
    empty: string;
    paid: PaperRow;
    due: PaperRow;
    settled: string | null;
  };
  note: PaperRow | null;
  signatures: { title: string; parties: string[]; hint: string };
  footer: string;
};

export function contractPaperContent(c: ContractForPaper, opts: { t: Translate; locale: string; now: number }): ContractPaperContent {
  const { t, locale } = opts;
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const dayFormat = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: BUSINESS_TIME_ZONE });
  const day = (ymd: string) => dayFormat.format(businessDayStartUtc(ymd));
  const shortDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const client = c.client;
  const balance = c.totalAmount - c.amountPaid;

  return {
    fileName: `${c.number}.pdf`,
    company: { name: COMPANY.name, details: COMPANY.details },
    title: t("paper.title"),
    kicker: t("paper.kicker"),
    number: c.number,
    seal: { ring: `${COMPANY.name} · ${t("paper.sealService")}`.toUpperCase(), number: c.number, date: shortDate.format(businessDayStartUtc(c.startDay)) },
    parties: [
      { heading: t("paper.provider"), name: COMPANY.name, lines: [...COMPANY.details] },
      {
        heading: t("paper.client"),
        name: client?.name ?? c.clientName,
        lines: [
          client ? t(`paper.clientKinds.${client.kind}`) : null,
          client?.contactName ? t("paper.contact", { name: client.contactName }) : null,
          client?.phone ?? null,
          client?.email ?? null,
          client?.address ?? null,
        ].filter((line): line is string => Boolean(line)),
      },
    ],
    vehicle: {
      title: t("paper.vehicle"),
      rows: [
        [t("paper.plate"), c.plateNumber],
        [t("paper.model"), c.carModel ?? "-"],
        [t("paper.driver"), c.driverName ?? "-"],
      ],
    },
    period: {
      title: t("paper.period"),
      rows: [
        [t("paper.from"), day(c.startDay)],
        [t("paper.to"), day(c.endDay)],
        [t("paper.duration"), t("paper.days", { days: c.days })],
      ],
    },
    price: {
      title: t("paper.price"),
      rows: [
        [t("paper.dayRate"), money(c.dayRate)],
        [t("paper.computed", { days: c.days }), money(c.computedTotal)],
      ],
      total: [t("paper.total"), money(c.totalAmount)],
      reason: c.priceChangeReason ? t("paper.priceReason", { reason: c.priceChangeReason }) : null,
    },
    payments: {
      title: t("paper.payments"),
      head: [t("paper.paymentDate"), t("paper.paymentMethod"), t("paper.paymentAmount")],
      rows: [...c.payments]
        .sort((a, b) => a.paidAt - b.paidAt)
        .map((p) => [
          shortDate.format(p.paidAt),
          p.kind === "reversal" ? t("paper.reversal", { method: t(`methods.${p.method}`) }) : t(`methods.${p.method}`),
          money(p.amount),
        ]),
      empty: t("paper.noPayments"),
      paid: [t("paper.totalPaid"), money(c.amountPaid)],
      due: [t("paper.balanceDue"), money(balance)],
      settled: balance <= 0 ? t("paper.paidInFull") : null,
    },
    note: c.note ? [t("paper.note"), c.note] : null,
    signatures: { title: t("paper.signatures"), parties: [t("paper.forClient"), t("paper.forCompany", { company: COMPANY.name })], hint: t("paper.signHint") },
    footer: t("paper.footer", { number: c.number, date: shortDate.format(opts.now) }),
  };
}

// ------------------------------------------------------------------ drawing

const INK: [number, number, number] = [26, 46, 34];
const MUTED: [number, number, number] = [110, 118, 112];
const RED: [number, number, number] = [185, 28, 28];
const GREEN: [number, number, number] = [47, 122, 74];
const MARGIN = 18;

/**
 * Draws the contract paper on A4 - brand bar, company, title, the round
 * seal, parties, vehicle, period, price, payments, signatures - and saves
 * it. jsPDF is loaded only now, so the page itself stays light.
 */
export async function renderContractPdf(content: ContractPaperContent, pageLabel: (page: number, pages: number) => string) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const right = width - MARGIN;
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  const text = (value: string, x: number, y: number, opts: { size: number; bold?: boolean; italic?: boolean; color?: [number, number, number]; align?: "left" | "right" | "center" }) => {
    doc.setFont("helvetica", opts.bold ? "bold" : opts.italic ? "italic" : "normal");
    doc.setFontSize(opts.size);
    doc.setTextColor(...(opts.color ?? INK));
    doc.text(pdfSafe(value), x, y, { align: opts.align ?? "left" });
  };
  let y = 0;
  const ensureRoom = (needed: number) => {
    if (y + needed > height - 22) {
      doc.addPage();
      y = 22;
    }
  };
  const heading = (title: string, x: number) => text(title.toUpperCase(), x, y, { size: 8, bold: true, color: INK });
  const rows = (items: PaperRow[], x: number, w: number, startY: number) => {
    let rowY = startY;
    for (const [label, value] of items) {
      text(label, x, rowY, { size: 9.5, color: MUTED });
      text(value, x + w, rowY, { size: 9.5, bold: true, align: "right" });
      rowY += 5.5;
    }
    return rowY;
  };

  // Brand bar and header.
  doc.setFillColor(...INK);
  doc.rect(0, 0, width, 3, "F");
  text(content.company.name, MARGIN, 22, { size: 17, bold: true });
  y = 27;
  for (const line of content.company.details) {
    text(line, MARGIN, y, { size: 8.5, color: MUTED });
    y += 4;
  }
  y += 6;
  text(content.kicker.toUpperCase(), MARGIN, y, { size: 8, bold: true, color: MUTED });
  y += 8;
  text(content.title, MARGIN, y, { size: 20, bold: true });
  y += 6;
  text(content.number, MARGIN, y, { size: 10, color: MUTED });

  // The seal: three circles, the company around the ring, the number in the middle.
  const cx = right - 21;
  const cy = 30;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.9);
  doc.circle(cx, cy, 20, "S");
  doc.setLineWidth(0.3);
  doc.circle(cx, cy, 18.4, "S");
  doc.setLineWidth(0.45);
  doc.circle(cx, cy, 12, "S");
  const ring = pdfSafe(`${content.seal.ring} · `);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.2);
  doc.setTextColor(...INK);
  const step = (2 * Math.PI) / ring.length;
  for (let i = 0; i < ring.length; i++) {
    const theta = i * step;
    const r = 14.2;
    doc.text(ring[i], cx + r * Math.sin(theta), cy - r * Math.cos(theta), { angle: (-theta * 180) / Math.PI, align: "center" });
  }
  text(content.seal.number.replace(/^CONTRACT-/, "N° "), cx, cy + 1, { size: 8.5, bold: true, align: "center" });
  text(content.seal.date, cx, cy + 5, { size: 5.8, align: "center" });

  // Double rule.
  y += 8;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, y, right, y);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y + 1, right, y + 1);
  y += 9;

  // Parties, side by side.
  const half = (right - MARGIN) / 2;
  const col2 = MARGIN + half + 6;
  let partyEnd = y;
  content.parties.forEach((party, i) => {
    const x = i === 0 ? MARGIN : col2;
    let py = y;
    text(party.heading.toUpperCase(), x, py, { size: 8, bold: true });
    py += 6;
    text(party.name, x, py, { size: 11, bold: true });
    py += 5;
    for (const line of party.lines) {
      text(line, x, py, { size: 9, color: MUTED });
      py += 4.5;
    }
    partyEnd = Math.max(partyEnd, py);
  });
  y = partyEnd + 6;

  // Vehicle and period, side by side.
  ensureRoom(30);
  heading(content.vehicle.title, MARGIN);
  text(content.period.title.toUpperCase(), col2, y, { size: 8, bold: true });
  const colWidth = half - 6;
  const end1 = rows(content.vehicle.rows, MARGIN, colWidth, y + 6);
  const end2 = rows(content.period.rows, col2, colWidth, y + 6);
  y = Math.max(end1, end2) + 6;

  // Price.
  ensureRoom(32);
  heading(content.price.title, MARGIN);
  y = rows(content.price.rows, MARGIN, right - MARGIN, y + 6);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y - 2.5, right, y - 2.5);
  text(content.price.total[0], MARGIN, y + 2, { size: 11, bold: true });
  text(content.price.total[1], right, y + 2, { size: 12, bold: true, align: "right" });
  y += 7;
  if (content.price.reason) {
    text(content.price.reason, MARGIN, y, { size: 8.5, italic: true, color: MUTED });
    y += 5;
  }
  y += 4;

  // Payments received.
  ensureRoom(24);
  heading(content.payments.title, MARGIN);
  y += 2;
  if (content.payments.rows.length === 0) {
    text(content.payments.empty, MARGIN, y + 4, { size: 9.5, italic: true, color: MUTED });
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, bottom: 22 },
      theme: "plain",
      head: [content.payments.head.map(pdfSafe)],
      body: content.payments.rows.map((row) => row.map(pdfSafe)),
      styles: { font: "helvetica", fontSize: 9.5, cellPadding: { top: 1.6, bottom: 1.6, left: 0, right: 0 }, textColor: INK },
      headStyles: { textColor: MUTED, fontStyle: "normal", fontSize: 8.5 },
      columnStyles: { 2: { halign: "right" } },
      didParseCell: (data) => {
        // The amount header lines up with the amounts.
        if (data.section === "head" && data.column.index === 2) data.cell.styles.halign = "right";
      },
      didDrawCell: (data) => {
        if (data.section === "head" && data.column.index === 0) {
          doc.setDrawColor(190, 190, 190);
          doc.setLineWidth(0.2);
          doc.line(MARGIN, data.cell.y + data.cell.height, right, data.cell.y + data.cell.height);
        }
      },
    });
    y = lastY() + 4;
  }
  ensureRoom(18);
  const totalsX = right - 70;
  text(content.payments.paid[0], totalsX, y + 2, { size: 9.5, color: MUTED });
  text(content.payments.paid[1], right, y + 2, { size: 9.5, bold: true, align: "right" });
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.4);
  doc.line(totalsX, y + 4.5, right, y + 4.5);
  text(content.payments.due[0], totalsX, y + 9, { size: 10.5, bold: true });
  text(content.payments.due[1], right, y + 9, { size: 11, bold: true, align: "right", color: content.payments.settled ? INK : RED });
  if (content.payments.settled) {
    // A green "Paid in full" stamp beside the totals.
    const label = pdfSafe(content.payments.settled.toUpperCase());
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    const w = doc.getTextWidth(label) + 6;
    doc.setDrawColor(...GREEN);
    doc.setLineWidth(0.7);
    doc.roundedRect(MARGIN + 4, y, w, 9, 1.5, 1.5, "S");
    doc.setTextColor(...GREEN);
    doc.text(label, MARGIN + 7, y + 6.2);
  }
  y += 16;

  if (content.note) {
    const lines = doc.splitTextToSize(pdfSafe(content.note[1]), right - MARGIN) as string[];
    ensureRoom(10 + lines.length * 4.5);
    heading(content.note[0], MARGIN);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    doc.text(lines, MARGIN, y + 6);
    y += 8 + lines.length * 4.5;
  }

  // Signatures.
  ensureRoom(40);
  y += 4;
  heading(content.signatures.title, MARGIN);
  y += 7;
  content.signatures.parties.forEach((party, i) => {
    const x = i === 0 ? MARGIN : col2;
    text(party, x, y, { size: 10, bold: true });
    doc.setDrawColor(...INK);
    doc.setLineWidth(0.3);
    doc.line(x, y + 20, x + colWidth, y + 20);
    text(content.signatures.hint, x, y + 24.5, { size: 8, color: MUTED });
  });

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, height - 15, right, height - 15);
    text(content.footer, MARGIN, height - 10, { size: 7.5, color: MUTED });
    text(pageLabel(page, pages), right, height - 10, { size: 7.5, color: MUTED, align: "right" });
  }
  doc.save(content.fileName);
}
