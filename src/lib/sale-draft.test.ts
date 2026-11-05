import { expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { SALE_DRAFT_VERSION, isEmptyDraft, parseDraft, saleDraftKey, serializeDraft, type SaleDraft } from "./sale-draft";

const window = { today: "2026-11-05", earliest: "2026-10-27" };

const draft: SaleDraft = {
  locationId: "loc1",
  lines: [
    { key: 1, productId: "p1" as Id<"products">, qty: 2, price: 1500, reason: "" },
    { key: 3, productId: "p2" as Id<"products">, qty: 1, price: null, reason: "regular" },
  ],
  payment: "credit",
  customer: "",
  creditCustomer: { _id: "c1" as Id<"customers">, name: "Amani" },
  paidNow: 500,
  paidNowMethod: "mobile_money",
  agreed: { value: 2800, linesTotal: 3000 },
  saleReason: "loyal customer",
  soldOn: "2026-11-03",
};

const empty: SaleDraft = {
  ...draft,
  lines: [],
  payment: "cash",
  creditCustomer: null,
  paidNow: 0,
  paidNowMethod: "cash",
  agreed: null,
  saleReason: "",
  soldOn: window.today,
};

test("a draft survives a round trip", () => {
  expect(parseDraft(serializeDraft(draft), window)).toEqual(draft);
});

test("missing, broken or other-version drafts are ignored", () => {
  expect(parseDraft(null, window)).toBeNull();
  expect(parseDraft("{not json", window)).toBeNull();
  expect(parseDraft("42", window)).toBeNull();
  expect(parseDraft(JSON.stringify({ ...draft, version: SALE_DRAFT_VERSION + 1 }), window)).toBeNull();
  expect(parseDraft(JSON.stringify({ ...draft, version: SALE_DRAFT_VERSION, payment: "card" }), window)).toBeNull();
  const badLine = { ...draft, lines: [{ ...draft.lines[0], qty: 0 }] };
  expect(parseDraft(JSON.stringify({ version: SALE_DRAFT_VERSION, ...badLine }), window)).toBeNull();
  const floatPrice = { ...draft, lines: [{ ...draft.lines[0], price: 12.5 }] };
  expect(parseDraft(JSON.stringify({ version: SALE_DRAFT_VERSION, ...floatPrice }), window)).toBeNull();
});

test("a sale day outside the backdate window goes back to today", () => {
  const old = serializeDraft({ ...draft, soldOn: "2026-10-01" });
  expect(parseDraft(old, window)?.soldOn).toBe(window.today);
  const future = serializeDraft({ ...draft, soldOn: "2026-11-06" });
  expect(parseDraft(future, window)?.soldOn).toBe(window.today);
});

test("an untouched form is an empty draft", () => {
  expect(isEmptyDraft(empty)).toBe(true);
  expect(isEmptyDraft({ ...empty, customer: " Joe " })).toBe(false);
  expect(isEmptyDraft({ ...empty, lines: draft.lines })).toBe(false);
  expect(isEmptyDraft({ ...empty, creditCustomer: draft.creditCustomer })).toBe(false);
  expect(isEmptyDraft({ ...empty, customer: "   " })).toBe(true);
});

test("drafts are kept per user and service", () => {
  expect(saleDraftKey("u1", "hair")).not.toBe(saleDraftKey("u2", "hair"));
  expect(saleDraftKey("u1", "hair")).not.toBe(saleDraftKey("u1", "fashion"));
});
