import { expect, test } from "vitest";
import { QUOTE_COUNT, firstName, nextQuote, tierFor } from "./sale-celebration";

test("tierFor: seedling, star, trophy, crown", () => {
  expect([1, 9, 10, 19, 20, 39, 40, 120].map(tierFor)).toEqual([
    "seedling",
    "seedling",
    "star",
    "star",
    "trophy",
    "trophy",
    "crown",
    "crown",
  ]);
});

test("nextQuote never repeats the previous quote and stays in range", () => {
  for (let previous = 0; previous < QUOTE_COUNT; previous++) {
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const q = nextQuote(previous, () => r);
      expect(q).not.toBe(previous);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThan(QUOTE_COUNT);
    }
  }
  expect(nextQuote(null, () => 0.99)).toBe(QUOTE_COUNT - 1);
});

test("firstName", () => {
  expect(firstName("  Danny Baraka ")).toBe("Danny");
  expect(firstName("")).toBeNull();
  expect(firstName(undefined)).toBeNull();
});
