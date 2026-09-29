import { expect, test } from "vitest";
import { formatMoney, isMoneyField, minorToInput, parseMoneyToMinor, snapshotCurrency } from "./money";

test("parses dollars and cents into integer cents", () => {
  expect(parseMoneyToMinor("12")).toBe(1200);
  expect(parseMoneyToMinor("12.5")).toBe(1250);
  expect(parseMoneyToMinor("12.50")).toBe(1250);
  expect(parseMoneyToMinor("0.07")).toBe(7);
  expect(parseMoneyToMinor(" 1,234.56 ")).toBe(123456);
  expect(parseMoneyToMinor("12.")).toBe(1200);
});

test("rejects negatives, more than two decimals and junk", () => {
  for (const bad of ["", "-1", "1.234", "abc", "1.2.3", "$5"]) {
    expect(parseMoneyToMinor(bad)).toBeNull();
  }
});

test("round-trips through the editing format", () => {
  expect(minorToInput(1250)).toBe("12.50");
  expect(minorToInput(7)).toBe("0.07");
  expect(parseMoneyToMinor(minorToInput(98765))).toBe(98765);
});

test("formats for display in the user's locale", () => {
  expect(formatMoney(123456, "USD", "en")).toBe("$1,234.56");
  expect(formatMoney(1250, "USD", "fr")).toMatch(/12,50/);
});

test("money fields are recognised by name", () => {
  for (const key of ["amount", "unitCost", "purchasedTotal", "expensesTotal", "grandTotal", "salePrice", "paidAmount"]) {
    expect(isMoneyField(key)).toBe(true);
  }
  for (const key of ["purchasedLines", "qtyPurchased", "currency", "number", "amounts", "costing"]) {
    expect(isMoneyField(key)).toBe(false);
  }
});

test("a snapshot's currency is the first valid one found", () => {
  expect(snapshotCurrency(undefined, { currency: "CDF" }, { currency: "USD" })).toBe("CDF");
  expect(snapshotCurrency({ currency: "EUR" }, null)).toBeNull();
});
