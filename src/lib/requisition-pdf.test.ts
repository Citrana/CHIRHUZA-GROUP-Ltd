import { expect, test } from "vitest";
import en from "../../messages/en.json";
import { pdfSafe, type PdfDocument, type Translate } from "./pdf/document";
import { requisitionPdfContent, type RequisitionForPdf } from "./requisition-pdf";

/** The real English "Requisitions" messages, with simple {placeholder} filling. */
const t: Translate = (key, values = {}) => {
  const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en.Requisitions);
  return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

// 3 Oct 2026, 08:15 UTC = 10:15 in Lubumbashi.
const AT = Date.UTC(2026, 9, 3, 8, 15);

function requisition(overrides: Partial<RequisitionForPdf> = {}): RequisitionForPdf {
  return {
    _id: "r1",
    _creationTime: AT,
    number: "REQ-00005",
    status: "draft",
    locationName: "Boutique la grace 2",
    note: "Wigs for next month",
    createdByName: "Baraka Danny",
    submittedAt: undefined,
    approval: null,
    items: [
      {
        _id: "i1",
        productName: "Bob",
        sku: "HAIR-00002",
        lengthInches: 14,
        colourName: "1B",
        sizeName: null,
        qtyRequested: 5,
        note: undefined,
        resolution: "pending",
        addedByBuyer: undefined,
        purchases: [],
      },
    ],
    ...overrides,
  } as unknown as RequisitionForPdf;
}

/**
 * The document flattened as the requisition PDF had it before the shared
 * builder (details, table rows, empty text), with pdfSafe applied as
 * renderPdf does.
 */
const content = (r: RequisitionForPdf) => {
  const doc: PdfDocument = requisitionPdfContent(r, { t, locale: "en", serviceName: "Hair", downloadedBy: "Aline", now: AT });
  const [details, products] = doc.sections;
  return {
    fileName: doc.fileName,
    brand: doc.brand,
    title: doc.title,
    details: details.details!.map(([label, value]) => [pdfSafe(label), pdfSafe(value)]),
    body: (products.table?.body ?? []).map((row) => row.map(pdfSafe)),
    emptyText: products.emptyText ?? null,
    footer: pdfSafe(doc.footer),
  };
};

test("a draft: details in Lubumbashi time, not submitted, no decision", () => {
  const c = content(requisition());
  expect(c.fileName).toBe("REQ-00005.pdf");
  expect(c.title).toBe("Requisition REQ-00005");
  expect(c.brand).toBe("CHIRHUZA GROUP Ltd · Hair");
  expect(c.details).toEqual([
    ["Status", "Draft"],
    ["Location", "Boutique la grace 2"],
    ["Created by", "Baraka Danny on Oct 3, 2026, 10:15 AM"],
    ["Submitted", "Not submitted yet"],
    ["Note", "Wigs for next month"],
  ]);
  expect(c.body).toEqual([["1", 'Bob · 14" · 1B', "HAIR-00002", "5", "", "Pending"]]);
  expect(c.emptyText).toBeNull();
  expect(c.footer).toBe("Downloaded by Aline on Oct 3, 2026, 10:15 AM");
});

test("approved and rejected requisitions show who decided, when, and the note", () => {
  const approved = content(
    requisition({
      status: "approved",
      submittedAt: AT,
      approval: { _id: "a1", status: "approved", decidedByName: "Chief", decidedAt: AT + 3600_000, decisionNote: null },
    } as Partial<RequisitionForPdf>),
  );
  expect(approved.details).toContainEqual(["Decision", "Approved by Chief on Oct 3, 2026, 11:15 AM"]);
  expect(approved.details).toContainEqual(["Submitted", "Oct 3, 2026, 10:15 AM"]);

  const rejected = content(
    requisition({
      status: "rejected",
      submittedAt: AT,
      approval: { _id: "a1", status: "rejected", decidedByName: "Chief", decidedAt: AT, decisionNote: "Too many wigs" },
    } as Partial<RequisitionForPdf>),
  );
  expect(rejected.details).toContainEqual(["Decision", "Rejected by Chief on Oct 3, 2026, 10:15 AM"]);
  expect(rejected.details).toContainEqual(["Decision note", "Too many wigs"]);
});

test("purchasing: batch, quantity bought and reasons; buyer-added lines are marked", () => {
  const c = content(
    requisition({
      status: "closed",
      items: [
        {
          productName: "Bob",
          sku: "HAIR-00002",
          lengthInches: 14,
          colourName: "1B",
          sizeName: null,
          qtyRequested: 6,
          note: "Black only",
          resolution: "partial",
          purchases: [{ batchNumber: "BATCH-00001", batchStatus: "received", status: "purchased", qtyPurchased: 4, reason: "Supplier had only 4" }],
        },
        {
          productName: "Deep Wave Wig",
          sku: "HAIR-00007",
          lengthInches: 22,
          colourName: "99J",
          sizeName: null,
          qtyRequested: 3,
          resolution: "not_purchased",
          purchases: [{ batchNumber: "BATCH-00001", batchStatus: "received", status: "not_purchased", qtyPurchased: 0, reason: "Out of stock" }],
        },
        {
          productName: "Edge Control",
          sku: "HAIR-00017",
          lengthInches: null,
          colourName: null,
          sizeName: null,
          qtyRequested: 20,
          resolution: "purchased",
          addedByBuyer: true,
          purchases: [{ batchNumber: "BATCH-00001", batchStatus: "received", status: "purchased", qtyPurchased: 20, reason: null }],
        },
      ],
    } as unknown as Partial<RequisitionForPdf>),
  );
  expect(c.body.map((row) => [row[1], row[4], row[5]])).toEqual([
    ['Bob · 14" · 1B', "Black only", "Partial\n4 bought in BATCH-00001 (Supplier had only 4)"],
    ['Deep Wave Wig · 22" · 99J', "", "Not purchased\nnot bought in BATCH-00001 (Out of stock)"],
    ["Edge Control\nAdded by the buyer", "", "Purchased\n20 bought in BATCH-00001"],
  ]);
});

test("an empty requisition says the buyer chooses the products", () => {
  const c = content(requisition({ items: [] }));
  expect(c.body).toEqual([]);
  expect(c.emptyText).toMatch(/buyer chooses/);
});
