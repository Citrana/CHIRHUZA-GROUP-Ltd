import { expect, test } from "vitest";
import {
  currentCursor,
  initialCursorPagination,
  nextPage,
  pageIndex,
  previousPage,
  syncCursorPagination,
} from "./cursor-pagination";

test("starts on page 1 with a null cursor", () => {
  const state = initialCursorPagination("k");
  expect(pageIndex(state)).toBe(0);
  expect(currentCursor(state)).toBeNull();
});

test("next pushes the continue cursor; previous goes back to the page's own cursor", () => {
  let state = initialCursorPagination("k");
  state = nextPage(state, "c1");
  state = nextPage(state, "c2");
  expect(pageIndex(state)).toBe(2);
  expect(currentCursor(state)).toBe("c2");

  state = previousPage(state);
  expect(pageIndex(state)).toBe(1);
  expect(currentCursor(state)).toBe("c1");

  state = previousPage(state);
  expect(currentCursor(state)).toBeNull();
});

test("previous on page 1 is a no-op", () => {
  const state = initialCursorPagination("k");
  expect(previousPage(state)).toBe(state);
});

test("a changed key (new filters or page size) resets to page 1", () => {
  const onPage3 = nextPage(nextPage(initialCursorPagination("a"), "c1"), "c2");
  expect(syncCursorPagination(onPage3, "a")).toBe(onPage3);
  const reset = syncCursorPagination(onPage3, "b");
  expect(reset.key).toBe("b");
  expect(pageIndex(reset)).toBe(0);
  expect(currentCursor(reset)).toBeNull();
});
