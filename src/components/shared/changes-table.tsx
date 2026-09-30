"use client";

import { useLocale, useTranslations } from "next-intl";
import { snapshotCurrency } from "../../../convex/lib/money";
import {
  formatSnapshotValue,
  isLineItems,
  orderSnapshotFields,
  type LineItem,
} from "@/lib/audit-summary";
import { cn } from "@/lib/utils";

type Snapshot = Record<string, unknown> | null | undefined;

/**
 * Field-by-field before/after table for a change: used for audit entries
 * and approval payloads. Shows only the columns that exist (a create has no
 * "before", a delete no "after"), and highlights fields whose value changed.
 * Money fields (integer cents) are shown formatted in the snapshot's currency,
 * `items` lists (isLineItems) as product / inches / colour / pieces, and
 * known fields under a translated label (`Changes.fields.<key>`).
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
  const locale = useLocale();
  const empty = t("empty");
  const format = (snapshot: Snapshot, field: string) => {
    const value = snapshot?.[field];
    if (isLineItems(value)) return <LineItems items={value} />;
    return formatSnapshotValue(field, value, {
      currency: snapshotCurrency(snapshot, before, after),
      locale,
      empty,
    });
  };
  const cellClass = (snapshot: Snapshot, field: string) =>
    cn("p-2", isLineItems(snapshot?.[field]) ? "min-w-56" : "break-all");
  const labelKey = (field: string) => `fields.${field}` as Parameters<typeof t>[0];
  const fields = orderSnapshotFields([
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ]);
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
              {t.has(labelKey(field)) ? (
                <td className="p-2 align-top text-muted-foreground">{t(labelKey(field))}</td>
              ) : (
                <td className="p-2 align-top font-mono text-xs">{field}</td>
              )}
              {before ? <td className={cellClass(before, field)}>{format(before, field)}</td> : null}
              {after ? <td className={cellClass(after, field)}>{format(after, field)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An `items` list: each line's product, inches and colour, then its pieces. */
function LineItems({ items }: { items: LineItem[] }) {
  const t = useTranslations("Changes");
  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((item, i) => (
        <li key={i} className="flex items-start justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
          <span className="min-w-0">
            <span className="block font-medium">
              {[
                item.product,
                typeof item.lengthInches === "number" ? `${item.lengthInches}″` : null,
                item.colour,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {item.sku || item.batch ? (
              <span className="block text-xs text-muted-foreground">
                {[item.sku, item.batch].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 font-medium whitespace-nowrap tabular-nums">
            {t("pieces", { count: item.qty })}
          </span>
        </li>
      ))}
    </ul>
  );
}
