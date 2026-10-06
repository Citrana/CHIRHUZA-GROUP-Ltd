import { expect, test } from "vitest";
import en from "../../messages/en.json";
import { batchPdfContent, type BatchForPdf } from "./batch-pdf";
import { pdfSafe, type Translate } from "./pdf/document";

/** The real English messages of a namespace, with simple {placeholder} filling. */
const translator =
  (messages: unknown): Translate =>
  (key, values = {}) => {
    const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages);
    return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  };

// 3 Oct 2026, 08:15 UTC = 10:15 in Lubumbashi.
const AT = Date.UTC(2026, 9, 3, 8, 15);
const HOUR = 3600_000;

const item = (overrides: Record<string, unknown>) => ({
  productName: "Bob",
  sku: "HAIR-00001",
  lengthInches: 12,
  colourName: "1B",
  sizeName: null,
  requisitionNumber: "REQ-00001",
  status: "purchased",
  qtyRequested: 10,
  qtyPurchased: 10,
  unitCost: 3500,
  reason: undefined,
  qtyReceived: undefined,
  qtyDamaged: undefined,
  receiveReason: undefined,
  missing: 0,
  ...overrides,
});

function batch(overrides: Record<string, unknown> = {}): BatchForPdf {
  return {
    _creationTime: AT,
    number: "BATCH-00001",
    title: "Guangzhou, September 2026",
    description: "Restock for both shops",
    status: "draft",
    createdByName: "Baraka Danny",
    receivedByName: null,
    approval: null,
    items: [item({})],
    expenses: [],
    requisitions: [{ _id: "q1", number: "REQ-00001", status: "purchasing", locationName: "Boutique la grace 1" }],
    totals: { purchasedTotal: 35000, expensesTotal: 0, grandTotal: 35000 },
    ...overrides,
  } as unknown as BatchForPdf;
}

const render = (b: BatchForPdf) => {
  const doc = batchPdfContent(b, {
    t: translator(en.StockBatches),
    tRequisitions: translator(en.Requisitions),
    locale: "en",
    serviceName: "Hair",
    downloadedBy: "Aline",
    now: AT,
  });
  const safe = (s: string) => pdfSafe(s);
  return {
    ...doc,
    footer: safe(doc.footer),
    sections: doc.sections.map((s) => ({
      title: s.title,
      details: s.details?.map(([l, v]) => [l, safe(v)]),
      body: s.table?.body.map((row) => row.map(safe)),
      emptyText: s.emptyText,
    })),
  };
};

test("a draft batch: status, buyer, totals, lines; no receiving section, no expenses", () => {
  const c = render(batch());
  expect(c).toMatchObject({
    fileName: "BATCH-00001.pdf",
    brand: "CHIRHUZA GROUP Ltd · Hair",
    title: "Purchase batch BATCH-00001",
    subtitle: "Guangzhou, September 2026",
    footer: "Downloaded by Aline on Oct 3, 2026, 10:15 AM",
  });
  expect(c.sections.map((s) => s.title)).toEqual([
    undefined,
    "Totals",
    "Purchased (1)",
    "Trip expenses",
    "Requisitions covered",
  ]);
  expect(c.sections[0].details).toEqual([
    ["Status", "Draft"],
    ["Created by", "Baraka Danny on Oct 3, 2026, 10:15 AM"],
    ["Description", "Restock for both shops"],
  ]);
  expect(c.sections[1].details).toEqual([
    ["Goods purchased", "$350.00"],
    ["Expenses", "$0.00"],
    ["Total (goods + expenses)", "$350.00"],
  ]);
  expect(c.sections[2].body).toEqual([["1", 'Bob · 12" · 1B\nHAIR-00001', "REQ-00001", "10 of 10", "$35.00", "$350.00", ""]]);
  expect(c.sections[3].emptyText).toBe("No expenses.");
  expect(c.sections[4].body).toEqual([["REQ-00001", "Boutique la grace 1", "Purchasing"]]);
});

test("a received batch: dates and who, extras, not purchased, receiving counts, expenses", () => {
  const c = render(
    batch({
      status: "received",
      purchasedAt: AT,
      approvedAt: AT + HOUR,
      shippedAt: AT + 2 * HOUR,
      arrivedAt: AT + 3 * HOUR,
      receivedAt: AT + 4 * HOUR,
      receivedByName: "Goma Manager",
      approval: { kind: "approve", status: "approved", decidedByName: "Chief", decisionNote: null },
      items: [
        item({ qtyReceived: 9, qtyDamaged: 0, missing: 1, receiveReason: "1 missing from the box" }),
        item({ productName: "Wig Cap", sku: "HAIR-00018", lengthInches: null, colourName: null, requisitionNumber: null, qtyRequested: 0, qtyPurchased: 30, unitCost: 100, qtyReceived: 30, qtyDamaged: 0 }),
        item({ productName: "Deep Wave Wig", sku: "HAIR-00007", lengthInches: 22, colourName: "99J", status: "not_purchased", qtyRequested: 3, qtyPurchased: 0, unitCost: undefined, reason: "Out of stock at the supplier" }),
      ],
      expenses: [
        { category: "freight", amount: 25000, note: "Air cargo", receiptFileId: "f1" },
        { category: "meals", amount: 3500, note: undefined, receiptFileId: undefined },
      ],
      totals: { purchasedTotal: 38000, expensesTotal: 28500, grandTotal: 66500 },
    }),
  );
  expect(c.sections[0].details).toEqual([
    ["Status", "Received"],
    ["Created by", "Baraka Danny on Oct 3, 2026, 10:15 AM"],
    ["Purchased", "Oct 3, 2026, 10:15 AM"],
    ["Approved", "Oct 3, 2026, 11:15 AM by Chief"],
    ["Shipped", "Oct 3, 2026, 12:15 PM"],
    ["Arrived", "Oct 3, 2026, 1:15 PM"],
    ["Received", "Oct 3, 2026, 2:15 PM by Goma Manager"],
    ["Description", "Restock for both shops"],
  ]);
  expect(c.sections.map((s) => s.title)).toEqual([
    undefined,
    "Totals",
    "Purchased (2)",
    "Not purchased (1)",
    "Receiving in Goma",
    "Trip expenses",
    "Requisitions covered",
  ]);
  expect(c.sections[1].details![2]).toEqual(["Total (goods + expenses)", "$665.00"]);
  expect(c.sections[2].body!.map((row) => [row[1].split("\n")[0], row[2], row[3], row[5]])).toEqual([
    ['Bob · 12" · 1B', "REQ-00001", "10 of 10", "$350.00"],
    ["Wig Cap", "Extra", "30", "$30.00"],
  ]);
  expect(c.sections[3].body).toEqual([['Deep Wave Wig · 22" · 99J\nHAIR-00007', "REQ-00001", "3", "Out of stock at the supplier"]]);
  expect(c.sections[4].body!.map((row) => row.slice(1))).toEqual([
    ["10", "9", "0", "1", "1 missing from the box"],
    ["30", "30", "0", "0", ""],
  ]);
  expect(c.sections[5].body).toEqual([
    ["Freight", "Air cargo", "$250.00", "Attached"],
    ["Meals", "", "$35.00", "-"],
  ]);
});
