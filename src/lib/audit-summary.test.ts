import { expect, test } from "vitest";
import {
  formatAuditValue,
  formatSnapshotValue,
  isLineItems,
  orderSnapshotFields,
  summarizeAuditEntry,
} from "./audit-summary";

test("an update summarizes its first readable change and counts the rest", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { address: "Av. 12", active: true },
      after: { address: "Av. 14", active: false },
    }),
  ).toEqual({ kind: "change", field: "active", from: true, to: false, more: 1 });
});

test("readable fields win over their raw id twins, which aren't counted", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { roleId: "r1", role: "sales_agent" },
      after: { roleId: "r2", role: "chief_admin" },
    }),
  ).toEqual({
    kind: "change",
    field: "role",
    from: "sales_agent",
    to: "chief_admin",
    more: 0,
  });
});

test("ids are used only when nothing readable exists", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { locationId: "l1" },
      after: { locationId: null },
    }),
  ).toMatchObject({ field: "locationId", from: "l1", to: null });
});

test("a create shows the most meaningful field of the new record", () => {
  expect(
    summarizeAuditEntry({
      action: "create",
      after: {
        type: "shop",
        businessUnitId: "b1",
        name: "Boutique la Grace",
        active: true,
      },
    }),
  ).toEqual({ kind: "value", field: "name", value: "Boutique la Grace", more: 0 });
});

test("a delete shows the removed record's most meaningful field", () => {
  expect(
    summarizeAuditEntry({
      action: "delete",
      before: { roleId: "r1", role: "sales_agent", permission: "users.manage" },
    }),
  ).toMatchObject({ kind: "value", field: "permission", value: "users.manage" });
});

test("no snapshots means no summary", () => {
  expect(summarizeAuditEntry({ action: "approve" })).toBeNull();
});

test("formatAuditValue", () => {
  expect(formatAuditValue(null, "—")).toBe("—");
  expect(formatAuditValue(undefined, "—")).toBe("—");
  expect(formatAuditValue(false, "—")).toBe("false");
  expect(formatAuditValue({ a: 1 }, "—")).toBe('{"a":1}');
});

test("formatSnapshotValue shows money fields as money, in the viewer's language", () => {
  const usd = { currency: "USD" as const, empty: "—" };
  expect(formatSnapshotValue("purchasedTotal", 86421, { ...usd, locale: "en" })).toBe("$864.21");
  expect(formatSnapshotValue("grandTotal", 100851, { ...usd, locale: "fr" })).toMatch(/^1\s008,51\s\$US$/);
  // Counts and text are left alone.
  expect(formatSnapshotValue("purchasedLines", 3, { ...usd, locale: "en" })).toBe("3");
  expect(formatSnapshotValue("number", "BATCH-00001", { ...usd, locale: "en" })).toBe("BATCH-00001");
  // Without a known currency, the raw value.
  expect(formatSnapshotValue("amount", 1250, { currency: null, locale: "en", empty: "—" })).toBe("1250");
  expect(formatSnapshotValue("amount", null, { ...usd, locale: "en" })).toBe("—");
});

test("orderSnapshotFields: identity first, money last, grand total at the very end", () => {
  // As a stock batch approval comes back from the database (alphabetical).
  expect(
    orderSnapshotFields([
      "currency",
      "expensesTotal",
      "grandTotal",
      "notPurchasedLines",
      "number",
      "purchasedLines",
      "purchasedTotal",
      "title",
    ]),
  ).toEqual([
    "number",
    "title",
    "purchasedLines",
    "notPurchasedLines",
    "currency",
    "purchasedTotal",
    "expensesTotal",
    "grandTotal",
  ]);
  expect(orderSnapshotFields(["status", "amount", "category", "name", "currency"])).toEqual([
    "name",
    "status",
    "category",
    "currency",
    "amount",
  ]);
});

test("isLineItems recognises an items list (product + whole qty)", () => {
  expect(
    isLineItems([
      { product: "Perique", lengthInches: 26, colour: "101", sku: "HAIR-00003", batch: "BATCH-00001", qty: 13 },
      { product: "Perique", qty: 2 },
    ]),
  ).toBe(true);
  for (const value of [[], "Perique × 13", [1, 2], [{ product: "P" }], [{ product: "P", qty: 1.5 }], null]) {
    expect(isLineItems(value)).toBe(false);
  }
});

test("a distribution reads: number, destination, items, total pieces", () => {
  expect(orderSnapshotFields(["items", "number", "to", "totalQty"])).toEqual(["number", "to", "items", "totalQty"]);
});
