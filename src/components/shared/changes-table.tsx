"use client";

import { useTranslations } from "next-intl";
import { formatAuditValue } from "@/lib/audit-summary";
import { cn } from "@/lib/utils";

type Snapshot = Record<string, unknown> | null | undefined;

/**
 * Field-by-field before/after table for a change: used for audit entries
 * and approval payloads. Shows only the columns that exist (a create has no
 * "before", a delete no "after"), and highlights fields whose value changed.
 */
export function ChangesTable({
  before,
  after,
  className,
}: {
  before?: Snapshot;
  after?: Snapshot;
  className?: string;
}) {
  const t = useTranslations("Changes");
  const empty = t("empty");
  const fields = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ];
  if (fields.length === 0) {
    return null;
  }
  const changed = (field: string) =>
    before &&
    after &&
    JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null);

  return (
    <div
      className={cn(
        "overflow-x-auto rounded-md border border-border bg-background",
        className,
      )}
    >
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="p-2 text-left font-medium">{t("field")}</th>
            {before ? <th className="p-2 text-left font-medium">{t("before")}</th> : null}
            {after ? <th className="p-2 text-left font-medium">{t("after")}</th> : null}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr
              key={field}
              className={cn(
                "border-t border-border",
                changed(field) && "bg-accent/40 font-medium",
              )}
            >
              <td className="p-2 font-mono text-xs">{field}</td>
              {before ? (
                <td className="p-2 break-all">{formatAuditValue(before[field], empty)}</td>
              ) : null}
              {after ? (
                <td className="p-2 break-all">{formatAuditValue(after[field], empty)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
