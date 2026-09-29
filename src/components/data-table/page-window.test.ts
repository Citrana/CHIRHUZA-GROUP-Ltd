import { expect, test } from "vitest";
import { pageWindow } from "./page-window";

test("small totals show every page", () => {
  expect(pageWindow(1, 1)).toEqual([1]);
  expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(pageWindow(1, 0)).toEqual([]);
});

test("near the start: ellipsis only before the last page", () => {
  expect(pageWindow(1, 12)).toEqual([1, 2, 3, 4, 5, "ellipsis-end", 12]);
  expect(pageWindow(4, 12)).toEqual([1, 2, 3, 4, 5, "ellipsis-end", 12]);
});

test("in the middle: ellipses on both sides of the current page", () => {
  expect(pageWindow(6, 12)).toEqual([1, "ellipsis-start", 5, 6, 7, "ellipsis-end", 12]);
});

test("near the end: ellipsis only after the first page", () => {
  expect(pageWindow(9, 12)).toEqual([1, "ellipsis-start", 8, 9, 10, 11, 12]);
  expect(pageWindow(12, 12)).toEqual([1, "ellipsis-start", 8, 9, 10, 11, 12]);
});

test("always includes the first, last and current page, never more than 7 slots", () => {
  for (let total = 1; total <= 30; total++) {
    for (let current = 1; current <= total; current++) {
      const items = pageWindow(current, total);
      expect(items).toContain(1);
      expect(items).toContain(total);
      expect(items).toContain(current);
      expect(items.length).toBeLessThanOrEqual(7);
    }
  }
});
