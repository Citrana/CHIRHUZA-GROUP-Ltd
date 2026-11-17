import { expect, test } from "vitest";
import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { estimateSectionHeight, type Translate } from "./pdf/document";
import { formatDayRanges, reportPdfContent, type ReportForView } from "./report-pdf";

// 16 Nov 2026, 07:00 UTC = 09:00 in Lubumbashi.
const AT = Date.UTC(2026, 10, 16, 7, 0);

const figures = { sales: 12_345, margin: 5_000, expenses: 1_000, payroll: 2_000, netProfit: 2_000, withdrawals: 500 };
const report = {
  _id: "r1",
  businessUnitKey: "hair",
  kind: "scheduled",
  from: "2026-11-09",
  to: "2026-11-15",
  status: "ready",
  error: null,
  generatedAt: AT,
  createdByName: "Super",
  sections: ["sales", "missingDays", "stock", "approvals", "credit", "cash"],
  content: {
    sales: {
      total: 12_345,
      previousTotal: 10_000,
      compareFrom: "2026-11-02",
      compareTo: "2026-11-08",
      currency: "USD",
      figures,
      previous: { ...figures, sales: 10_000, netProfit: 2_500 },
      byShop: [{ locationId: "l1", name: "Goma Shop", sales: 12_345 }],
      topProducts: [{ productId: "p1", name: "Bob", lengthInches: 14, sizeName: null, colourName: "1B", unitsSold: 3, revenue: 9_000, margin: 3_000 }],
      missingDaysCount: 3,
    },
    missingDays: {
      count: 3,
      shops: [{ locationId: "l1", name: "Goma Shop", days: ["2026-11-10", "2026-11-11", "2026-11-13"], count: 3, truncated: false }],
    },
    stock: {
      lowCount: 1,
      outCount: 1,
      low: [{ productId: "p1", name: "Bob", sku: "HAIR-00002", lengthInches: 14, sizeName: null, colourName: "1B", onHand: 2, outOfStockSince: null, sold30: 6, reorderQty: 4 }],
      out: [{ productId: "p2", name: "Serum", sku: "HAIR-00016", lengthInches: null, sizeName: null, colourName: null, onHand: 0, outOfStockSince: AT, sold30: 2, reorderQty: 2 }],
      value: 80_000,
      unitsOnHand: 40,
    },
    approvals: {
      count: 1,
      byType: [{ type: "withdrawal", count: 1 }],
      items: [{ approvalId: "a1", type: "withdrawal", amount: 2_500, currency: "USD", requestedByName: "Chief", requestedAt: AT }],
    },
    credit: {
      totalOwed: 5_000,
      customers: 2,
      top: [
        { customerId: "c2", name: "Baba Joe", balance: 1_000, oldestUnpaidAt: AT - 9 * 86_400_000, daysUnpaid: 9 },
        { customerId: "c1", name: "Mama Neema", balance: 4_000, oldestUnpaidAt: AT, daysUnpaid: 0 },
      ],
      currency: "USD",
    },
    cash: { onHand: 80_000, pendingOpeningCash: 700, pendingOpeningCashCount: 1, currency: "USD" },
  },
} as unknown as ReportForView;

function build(locale: "en" | "fr", r: ReportForView = report) {
  const messages = locale === "en" ? en : fr;
  const t = createTranslator({ locale, messages, namespace: "Reports" }) as unknown as Translate;
  const tTypes = createTranslator({ locale, messages, namespace: "Approvals.types" }) as unknown as (k: string) => string;
  return reportPdfContent(r, {
    t,
    tApprovalType: tTypes,
    inches: (n) => `${n}"`,
    locale,
    serviceKey: "hair",
    serviceName: "Hair",
    downloadedBy: "Super",
    now: AT,
  });
}

test("highlights first, then every section, each kept on one page", () => {
  const doc = build("en");
  expect(doc.fileName).toBe("report-hair-2026-11-09_2026-11-15.pdf");
  expect(doc.subtitle).toMatch(/^Based on data entered by Nov 16, 2026, 9:00/);
  expect(doc.sections.map((s) => s.title).filter(Boolean)).toEqual([
    "Highlights",
    "Sales",
    "Sales per shop",
    "Top 5 products",
    "3 days with no sales registered",
    "Low and sold-out stock",
    "Running low",
    "Sold out",
    "Waiting for approval (1)",
    "Customers owe",
    "Cash",
  ]);
  expect(doc.sections.filter((s) => s.title).every((s) => s.keepTogether)).toBe(true);

  const highlights = doc.sections.find((s) => s.title === "Highlights")!.highlights;
  expect(highlights).toEqual([
    "Sales went up 23.5% to $123.45 compared with the period before.",
    "3 days with no sales registered, in 1 shop.",
    "2 products to reorder (6 units suggested).",
    "Customers owe $50.00 (2 customers). The oldest debt is 9 days old.",
  ]);

  const sales = doc.sections.find((s) => s.title === "Sales")!;
  expect(sales.table!.head).toEqual(["", "This period", "Period before", "Change"]);
  expect(sales.table!.body).toContainEqual(["Net profit", "$20.00", "$25.00", "-20%"]);
  expect(sales.table!.body.at(-1)).toEqual(["Withdrawals", "$5.00", "$5.00", "0%"]);
  expect(sales.emptyText).toMatch(/may be lower than the real figures/);

  const missing = doc.sections.find((s) => s.title?.includes("no sales"))!;
  expect(missing.details).toEqual([["Goma Shop\n3 days", "Nov 10, 2026 – Nov 11, 2026, Nov 13, 2026"]]);
  expect(doc.sections.find((s) => s.title === "Running low")!.table!.body).toEqual([['Bob · 14" · 1B\nHAIR-00002', "2", "6", "4"]]);
  expect(doc.sections.find((s) => s.title === "Low and sold-out stock")!.details).toContainEqual(["Stock value (purchase cost)", "$800.00"]);
  expect(doc.sections.find((s) => s.title?.startsWith("Waiting"))!.table!.body).toEqual([["Withdrawal", "$25.00", "Chief", "Nov 16, 2026"]]);
  const credit = doc.sections.find((s) => s.title === "Customers owe")!;
  expect(credit.table!.body.map((r) => [r[0], r[3]])).toEqual([["Baba Joe", "9 days"], ["Mama Neema", "today"]]);
});

test("no previous period: no comparison columns", () => {
  const doc = build("en", {
    ...report,
    content: { ...report.content, sales: { ...report.content.sales!, previousTotal: null, compareFrom: null, compareTo: null, previous: null } },
  });
  const sales = doc.sections.find((s) => s.title === "Sales")!;
  expect(sales.table!.head).toEqual(["", "This period"]);
  expect(doc.sections[1].highlights?.[0]).toBe("Sales for the period: $123.45.");
});

test("in French too, and sections the viewer can't see are simply absent", () => {
  const { cash, ...rest } = report.content;
  void cash;
  const doc = build("fr", { ...report, content: rest });
  expect(doc.subtitle).toMatch(/^Selon les données saisies jusqu'au/);
  expect(doc.sections.map((s) => s.title)).not.toContain("Caisse");
  expect(doc.sections.map((s) => s.title)).toContain("Points clés");
  expect(doc.sections.find((s) => s.title === "Points clés")!.highlights![2]).toBe("2 produits à racheter (6 unités proposées).");
});

test("a report saved before the new fields still makes a PDF", () => {
  const doc = build("en", {
    ...report,
    content: {
      sales: { total: 100, previousTotal: null, compareFrom: null, compareTo: null, currency: "USD" },
      credit: { totalOwed: 500, customers: 1, top: [{ customerId: "c1", name: "Neema", balance: 500 }], currency: "USD" },
    },
  } as unknown as ReportForView);
  expect(doc.sections.find((s) => s.title === "Sales")!.details![0]).toEqual(["Total sales", "$1.00"]);
  expect(doc.sections.find((s) => s.title === "Customers owe")!.table!.head).toEqual(["Customer", "Owes"]);
});

test("ranges and section heights", () => {
  expect(formatDayRanges(["2026-11-02", "2026-11-01", "2026-11-05"], "en")).toBe("Nov 1, 2026 – Nov 2, 2026, Nov 5, 2026");
  const small = estimateSectionHeight({ title: "T", table: { head: ["a"], body: [["1"]] } });
  const big = estimateSectionHeight({ title: "T", table: { head: ["a"], body: Array.from({ length: 30 }, () => ["1\n2"]) } });
  expect(big).toBeGreaterThan(small * 10);
});
