import { expect, test } from "vitest";
import { diff } from "./audit";

test("diff keeps only changed fields", () => {
  expect(diff({ name: "A", status: "active" }, { name: "A", status: "blocked" })).toEqual({
    before: { status: "active" },
    after: { status: "blocked" },
  });
  expect(diff({ name: "A" }, { name: "A" })).toBeNull();
});

test("diff keeps the currency next to a changed amount", () => {
  expect(
    diff({ category: "freight", amount: 15_000, currency: "USD" }, { category: "freight", amount: 14_000, currency: "USD" }),
  ).toEqual({
    before: { amount: 15_000, currency: "USD" },
    after: { amount: 14_000, currency: "USD" },
  });
  // No amount changed: no currency either.
  expect(diff({ note: "a", amount: 1, currency: "USD" }, { note: "b", amount: 1, currency: "USD" })).toEqual({
    before: { note: "a" },
    after: { note: "b" },
  });
});
