import { expect, test } from "vitest";
import en from "../../messages/en.json";
import { pdfSafe, type Translate } from "./pdf/document";
import { stockPdfContent, type StockOverviewForPdf } from "./stock-pdf";

const t: Translate = (key, values = {}) => {
  const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en.Inventory);
  return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

// 6 Oct 2026, 08:15 UTC = 10:15 in Lubumbashi.
const AT = Date.UTC(2026, 9, 6, 8, 15);

const business = { id: "h0", type: "business", name: "business" };
const shopA = { id: "h1", type: "location", name: "Boutique la grace 1" };
const shopB = { id: "h2", type: "location", name: "Boutique la grace 2" };
const bob = { id: "p1", name: "Bob", sku: "HAIR-00002", lengthInches: 14, sizeName: null, colourName: "1B", suggestedPrice: 7000 };
const serum = { id: "p2", name: "Argan Oil Serum", sku: "HAIR-00016", lengthInches: null, sizeName: null, colourName: null, suggestedPrice: 900 };
const cap = { id: "p3", name: "Wig Cap", sku: "HAIR-00018", lengthInches: null, sizeName: null, colourName: null, suggestedPrice: null };
const lot1 = { id: "l1", batchNumber: "BATCH-00001", unitCost: 4000, receivedQty: 10, createdAt: AT };
const lot3 = { id: "l3", batchNumber: "BATCH-00003", unitCost: 4200, receivedQty: 8, createdAt: AT };

/** 6 Bob (4 at $40 in shop A, 2 at $42 in shop B), 10 serums, 5 caps (no price). */
function overview(scope: "all_locations" | "own_location" = "all_locations"): StockOverviewForPdf {
  return {
    scope,
    byProduct: [
      { product: serum, qty: 10, value: 4000, holders: [{ holder: business, qty: 10 }] },
      { product: bob, qty: 6, value: 4 * 4000 + 2 * 4200, holders: [{ holder: shopA, qty: 4 }, { holder: shopB, qty: 2 }] },
      { product: cap, qty: 5, value: 500, holders: [{ holder: shopA, qty: 5 }] },
    ],
    byLot: [
      { lot: lot1, product: bob, qty: 4, value: 16000, holders: [] },
      { lot: lot3, product: bob, qty: 2, value: 8400, holders: [] },
    ],
    byHolder: [
      { holder: business, qty: 10, value: 4000, lines: [] },
      { holder: shopA, qty: 9, value: 16500, lines: [] },
      { holder: shopB, qty: 2, value: 8400, lines: [] },
    ],
  } as unknown as StockOverviewForPdf;
}

const render = (o: StockOverviewForPdf) => {
  const doc = stockPdfContent(o, { t, locale: "en", serviceKey: "hair", serviceName: "Hair", downloadedBy: "Aline", now: AT });
  return {
    ...doc,
    subtitle: pdfSafe(doc.subtitle ?? ""),
    sections: doc.sections.map((s) => ({
      title: s.title,
      details: s.details,
      body: s.table?.body.map((row) => row.map(pdfSafe)),
      emptyText: s.emptyText,
    })),
  };
};

test("summary: units, value at cost, at selling prices, potential margin", () => {
  const c = render(overview());
  expect(c).toMatchObject({
    fileName: "stock-hair-2026-10-06.pdf",
    title: "Stock report",
    subtitle: "As of Oct 6, 2026, 10:15 AM",
  });
  expect(c.sections[0]).toMatchObject({
    title: "Summary",
    details: [
      ["Units on hand", "21"],
      ["Products in stock", "3"],
      ["Lots", "2"],
      // $40.00 + $244.00 + $5.00
      ["Stock value (purchase cost)", "$289.00"],
      // 10 x $9 + 6 x $70; the caps have no selling price.
      ["Value at selling prices", "$510.00\n1 product(s) without a selling price not included"],
      // $510.00 - ($40.00 + $244.00)
      ["Potential margin", "$226.00"],
    ],
  });
});

test("by location, by product (with where it is) and by lot", () => {
  const c = render(overview());
  const section = (title: string) => c.sections.find((s) => s.title === title)!;
  expect(section("By location").body).toEqual([
    ["Business (unassigned)", "Business", "10", "$40.00"],
    ["Boutique la grace 1", "Location", "9", "$165.00"],
    ["Boutique la grace 2", "Location", "2", "$84.00"],
  ]);
  expect(section("By product").body).toEqual([
    ["Argan Oil Serum\nHAIR-00016", "10", "$40.00", "$90.00", "Business (unassigned): 10"],
    ['Bob · 14" · 1B\nHAIR-00002', "6", "$244.00", "$420.00", "Boutique la grace 1: 4\nBoutique la grace 2: 2"],
    ["Wig Cap\nHAIR-00018", "5", "$5.00", "-", "Boutique la grace 1: 5"],
  ]);
  expect(section("By lot").body).toEqual([
    ['Bob · 14" · 1B\nHAIR-00002', "BATCH-00001", "Oct 6, 2026", "$40.00", "4", "$160.00"],
    ['Bob · 14" · 1B\nHAIR-00002', "BATCH-00003", "Oct 6, 2026", "$42.00", "2", "$84.00"],
  ]);
});

test("own_location viewers get a report marked as their location only; empty stock says so", () => {
  expect(render(overview("own_location")).subtitle).toBe("As of Oct 6, 2026, 10:15 AM · Your location only");
  const empty = render({ scope: "all_locations", byProduct: [], byLot: [], byHolder: [] } as unknown as StockOverviewForPdf);
  expect(empty.sections.map((s) => s.title ?? s.emptyText)).toContain("No stock on hand.");
  expect(empty.sections.find((s) => s.title === "By product")).toBeUndefined();
});
