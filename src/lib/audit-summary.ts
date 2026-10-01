import type { AuditAction } from "../../convex/lib/audit";
import { formatMoney, isMoneyField, type Currency } from "../../convex/lib/money";

/**
 * One-line summary of an audit entry for the compact audit list, e.g.
 * `status: active → blocked` (+1 more). Pure, so the UI only translates
 * and formats.
 */
export type AuditSummary =
  | { kind: "change"; field: string; from: unknown; to: unknown; more: number }
  | { kind: "value"; field: string; value: unknown; more: number };

type Snapshot = Record<string, unknown> | undefined;

/** Most human-meaningful fields first. */
const PREFERRED_FIELDS = [
  "name",
  "email",
  "permission",
  "role",
  "status",
  "location",
  "scope",
  "active",
];

function rank(field: string): number {
  const index = PREFERRED_FIELDS.indexOf(field);
  return index === -1 ? PREFERRED_FIELDS.length : index;
}

/** Readable fields in preference order; raw `…Id` fields only as a fallback. */
function orderedFields(fields: string[]): string[] {
  const readable = fields.filter((f) => !f.endsWith("Id"));
  const pool = readable.length > 0 ? readable : fields;
  return [...pool].sort((a, b) => rank(a) - rank(b));
}

export function summarizeAuditEntry(entry: {
  action: AuditAction;
  before?: Snapshot;
  after?: Snapshot;
}): AuditSummary | null {
  const { before, after } = entry;
  if (before && after) {
    const fields = orderedFields([
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ]);
    if (fields.length === 0) return null;
    const field = fields[0];
    return {
      kind: "change",
      field,
      from: before[field],
      to: after[field],
      more: fields.length - 1,
    };
  }
  const snapshot = after ?? before;
  if (!snapshot) return null;
  const fields = orderedFields(Object.keys(snapshot));
  if (fields.length === 0) return null;
  const field = fields[0];
  return { kind: "value", field, value: snapshot[field], more: 0 };
}

/** Display form of a snapshot value; `empty` stands in for null/missing. */
export function formatAuditValue(value: unknown, empty: string): string {
  if (value === null || value === undefined) return empty;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * One line of an `items` list in a snapshot or approval payload (e.g. a
 * distribution): what product, and how many pieces. The Approvals and
 * Audit pages list these instead of printing raw JSON.
 */
export type LineItem = {
  product: string;
  qty: number;
  lengthInches?: number | null;
  size?: string | null;
  colour?: string | null;
  sku?: string | null;
  batch?: string | null;
};

export function isLineItems(value: unknown): value is LineItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as LineItem).product === "string" &&
        Number.isSafeInteger((item as LineItem).qty),
    )
  );
}

/**
 * Fields in reading order within their group (see below); `grandTotal`
 * (the sum) always comes last.
 */
const FIELD_ORDER = [
  "to",
  "items",
  "totalQty",
  "purchasedLines",
  "notPurchasedLines",
  "amount",
  "unitCost",
  "purchasedTotal",
  "expensesTotal",
];

/**
 * Display order for a snapshot's fields (stored snapshots come back with
 * their keys sorted alphabetically): what the record is first (number,
 * title, name, ...), then the other fields, then the currency and the
 * money fields, ending with `grandTotal`.
 */
export function orderSnapshotFields(fields: string[]): string[] {
  const group = (field: string) => {
    if (field === "number" || field === "title" || PREFERRED_FIELDS.includes(field)) return 0;
    if (field === "grandTotal") return 4;
    if (field === "currency") return 2;
    if (isMoneyField(field)) return 3;
    return 1;
  };
  const within = (field: string) => {
    if (field === "number") return -2;
    if (field === "title") return -1;
    const preferred = PREFERRED_FIELDS.indexOf(field);
    if (preferred !== -1) return preferred;
    const known = FIELD_ORDER.indexOf(field);
    return known === -1 ? FIELD_ORDER.length : known;
  };
  return [...fields].sort(
    (a, b) => group(a) - group(b) || within(a) - within(b) || a.localeCompare(b),
  );
}

/**
 * Display form of one snapshot field: money fields (`isMoneyField`) holding
 * integer cents are formatted in the snapshot's currency when it's known
 * (payloads store cents, e.g. 86421 → "$864.21"); anything else as
 * `formatAuditValue`.
 */
export function formatSnapshotValue(
  field: string,
  value: unknown,
  { currency, locale, empty }: { currency: Currency | null; locale: string; empty: string },
): string {
  if (currency && isMoneyField(field) && Number.isSafeInteger(value)) {
    return formatMoney(value as number, currency, locale);
  }
  return formatAuditValue(value, empty);
}
