import type { AuditAction } from "../../convex/lib/audit";

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
