import { expect, test } from "vitest";
import { businessDayEndUtc, businessDayStartUtc } from "./time";

test("a business day starts at 22:00 UTC the previous day (UTC+2)", () => {
  expect(new Date(businessDayStartUtc("2026-09-28")).toISOString()).toBe(
    "2026-09-27T22:00:00.000Z",
  );
  expect(new Date(businessDayEndUtc("2026-09-28")).toISOString()).toBe(
    "2026-09-28T21:59:59.999Z",
  );
});

test("month and year boundaries roll over correctly", () => {
  expect(new Date(businessDayStartUtc("2026-01-01")).toISOString()).toBe(
    "2025-12-31T22:00:00.000Z",
  );
  expect(new Date(businessDayEndUtc("2026-02-28")).toISOString()).toBe(
    "2026-02-28T21:59:59.999Z",
  );
});

test("rejects malformed dates", () => {
  expect(() => businessDayStartUtc("28/09/2026")).toThrow();
});
