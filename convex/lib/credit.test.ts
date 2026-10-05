import { expect, test } from "vitest";
import { allocateRepayment, cleanCustomerName, customerNameKey, saleBalance, splitDiscount } from "./credit";

test("splitDiscount: proportional whole cents that add up exactly", () => {
  expect(splitDiscount([1000, 1500], 300)).toEqual([120, 180]);
  const shares = splitDiscount([333, 333, 334], 100);
  expect(shares.reduce((s, x) => s + x, 0)).toBe(100);
  expect(shares).toEqual([33, 33, 34]);
  expect(splitDiscount([500, 500], 0)).toEqual([0, 0]);
  expect(splitDiscount([500, 300], 800)).toEqual([500, 300]);
  expect(splitDiscount([0, 700], 7)).toEqual([0, 7]);
});

test("allocateRepayment: oldest sales first, never more than owed", () => {
  const sales = [{ id: "a", balance: 1000 }, { id: "b", balance: 500 }];
  expect(allocateRepayment(sales, 1200).map((p) => [p.sale.id, p.amount])).toEqual([
    ["a", 1000],
    ["b", 200],
  ]);
  expect(allocateRepayment(sales, 300).map((p) => [p.sale.id, p.amount])).toEqual([["a", 300]]);
  expect(() => allocateRepayment(sales, 1501)).toThrow();
});

test("customer names and balances", () => {
  expect(cleanCustomerName("  Mama   Neema ")).toBe("Mama Neema");
  expect(customerNameKey("MAMA  neema")).toBe("mama neema");
  expect(saleBalance({ totalAmount: 2200, amountPaid: 700 })).toBe(1500);
  expect(saleBalance({ totalAmount: 2200, amountPaid: undefined })).toBe(2200);
});
