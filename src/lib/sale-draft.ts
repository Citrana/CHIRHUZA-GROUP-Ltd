import type { Id } from "../../convex/_generated/dataModel";
import { PAYMENT_METHODS, type PaymentMethod } from "../../convex/lib/sales";
import { COLLECTION_METHODS, type CollectionMethod } from "../../convex/lib/credit";

/**
 * The unfinished sale form, kept in the seller's browser so it comes back
 * when they leave the page and return. A convenience only: the server
 * re-checks everything when the sale is recorded, and lines whose stock
 * has gone meanwhile are flagged by the form's own checks.
 */
export const SALE_DRAFT_VERSION = 1;

export type SaleDraftLine = {
  key: number;
  productId: Id<"products">;
  qty: number;
  price: number | null;
  reason: string;
};

export type SaleDraft = {
  locationId: string;
  lines: SaleDraftLine[];
  payment: PaymentMethod;
  customer: string;
  creditCustomer: { _id: Id<"customers">; name: string } | null;
  paidNow: number | null;
  paidNowMethod: CollectionMethod;
  agreed: { value: number; linesTotal: number } | null;
  saleReason: string;
  soldOn: string;
};

/** One draft per user and service: shop phones are shared. */
export function saleDraftKey(userId: string, service: string): string {
  return `chirhuza.saleDraft.${userId}.${service}`;
}

/** Nothing worth keeping: no products, no customer, no reason typed. */
export function isEmptyDraft(d: SaleDraft): boolean {
  return d.lines.length === 0 && !d.customer.trim() && !d.creditCustomer && !d.saleReason.trim();
}

export function serializeDraft(d: SaleDraft): string {
  return JSON.stringify({ version: SALE_DRAFT_VERSION, ...d });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function parseLine(v: unknown): SaleDraftLine | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if (!isInt(l.key) || !isStr(l.productId) || !isInt(l.qty) || l.qty < 1 || !isStr(l.reason)) return null;
  if (l.price !== null && !(isInt(l.price) && l.price >= 0)) return null;
  return { key: l.key, productId: l.productId as Id<"products">, qty: l.qty, price: l.price, reason: l.reason };
}

/**
 * The stored draft, or null when there is none or it can't be trusted
 * (bad JSON, another version, wrong shapes). A sale day that has left the
 * backdate window since goes back to today.
 */
export function parseDraft(raw: string | null, window: { today: string; earliest: string }): SaleDraft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.version !== SALE_DRAFT_VERSION) return null;
  if (!isStr(d.locationId) || !isStr(d.customer) || !isStr(d.saleReason) || !isStr(d.soldOn)) return null;
  if (!PAYMENT_METHODS.includes(d.payment as PaymentMethod)) return null;
  if (!COLLECTION_METHODS.includes(d.paidNowMethod as CollectionMethod)) return null;
  if (!Array.isArray(d.lines)) return null;
  const lines = d.lines.map(parseLine);
  if (lines.some((l) => l === null)) return null;
  if (d.paidNow !== null && !(isInt(d.paidNow) && d.paidNow >= 0)) return null;

  let creditCustomer: SaleDraft["creditCustomer"] = null;
  if (d.creditCustomer !== null) {
    const c = d.creditCustomer as Record<string, unknown> | undefined;
    if (!c || !isStr(c._id) || !isStr(c.name)) return null;
    creditCustomer = { _id: c._id as Id<"customers">, name: c.name };
  }
  let agreed: SaleDraft["agreed"] = null;
  if (d.agreed !== null) {
    const a = d.agreed as Record<string, unknown> | undefined;
    if (!a || !isInt(a.value) || !isInt(a.linesTotal)) return null;
    agreed = { value: a.value, linesTotal: a.linesTotal };
  }
  const inWindow = d.soldOn >= window.earliest && d.soldOn <= window.today;

  return {
    locationId: d.locationId,
    lines: lines as SaleDraftLine[],
    payment: d.payment as PaymentMethod,
    customer: d.customer,
    creditCustomer,
    paidNow: d.paidNow as number | null,
    paidNowMethod: d.paidNowMethod as CollectionMethod,
    agreed,
    saleReason: d.saleReason,
    soldOn: inWindow ? d.soldOn : window.today,
  };
}
