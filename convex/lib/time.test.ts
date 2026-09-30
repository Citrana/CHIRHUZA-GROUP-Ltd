import { expect, test } from "vitest";
import { addBusinessDays, businessDayEndUtc, businessDayOf, businessDayStartUtc } from "./time";

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

test("businessDayOf follows Lubumbashi midnight (22:00 UTC)", () => {
  expect(businessDayOf(Date.UTC(2026, 8, 29, 21, 59, 59, 999))).toBe("2026-09-29");
  expect(businessDayOf(Date.UTC(2026, 8, 29, 22, 0))).toBe("2026-09-30");
  expect(businessDayOf(businessDayStartUtc("2026-10-01"))).toBe("2026-10-01");
  expect(businessDayOf(businessDayEndUtc("2026-10-01"))).toBe("2026-10-01");
});

test("addBusinessDays crosses month and year ends", () => {
  expect(addBusinessDays("2026-10-01", -1)).toBe("2026-09-30");
  expect(addBusinessDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addBusinessDays("2026-03-01", -7)).toBe("2026-02-22");
});
