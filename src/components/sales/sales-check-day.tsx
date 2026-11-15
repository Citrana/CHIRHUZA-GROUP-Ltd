"use client";

import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { SaleDetails, type SaleRow } from "./sale-details";
import type { CheckRow, ListedItem } from "./sales-check-panel";

/**
 * One shop-day of Check sales: the entered list next to what the shop sold
 * that day, then that day's sales (sales.list, same scope) - each opens in
 * full, with "Request correction" to move it to another date.
 */
export function DaySheet({
  service,
  row,
  items,
  labelOf,
  dayLabel,
  onClose,
  onRequestEdit,
}: {
  service: BusinessUnitKey;
  row: CheckRow;
  items: ListedItem[];
  labelOf: (productId: Id<"products">) => string;
  dayLabel: (day: string) => string;
  onClose: () => void;
  onRequestEdit: (saleId: Id<"sales">) => void;
}) {
  const t = useTranslations("SalesCheck");
  const tSales = useTranslations("Sales");
  const locale = useLocale();
  const { results, pagination } = useCursorPaginatedQuery(api.sales.list, {
    businessUnitKey: service,
    from: row.day,
    to: row.day,
    locationId: row.locationId,
  });
  const sold = new Map(row.found.map((f) => [f.productId, f.units]));
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });

  const columns: DataTableColumn<SaleRow>[] = [
    {
      id: "number",
      header: tSales("numberHeader"),
      cell: ({ row: r }) => r.original.number,
      meta: { className: "whitespace-nowrap font-mono text-xs font-medium" },
    },
    { id: "time", header: tSales("dateHeader"), cell: ({ row: r }) => time.format(r.original.createdAt), meta: { className: "text-muted-foreground" } },
    {
      id: "total",
      header: tSales("totalHeader"),
      cell: ({ row: r }) => formatMoney(r.original.totalAmount, "USD", locale),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
  ];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>{t("dayTitle", { date: dayLabel(row.day), shop: row.locationName ?? "—" })}</SheetTitle>
          <SheetDescription>{t("dayHint")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4 text-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <section className="flex flex-col gap-1">
              <h3 className="font-medium">{t("yourList")}</h3>
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {items.map((item) => {
                  const units = sold.get(item.productId);
                  return (
                    <li key={item.productId} className="flex items-start justify-between gap-3 px-3 py-2">
                      <span className="min-w-0">{item.label}</span>
                      <span className={cn("shrink-0 text-right text-xs", units === undefined ? "text-destructive" : "text-muted-foreground")}>
                        {units === undefined
                          ? t("notSold")
                          : item.qty.trim()
                            ? t("enteredSold", { entered: item.qty.trim(), sold: units })
                            : t("soldUnits", { units })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="flex flex-col gap-1">
              <h3 className="font-medium">{t("soldThatDay")}</h3>
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {row.found.map((f) => (
                  <li key={f.productId} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">{labelOf(f.productId)}</span>
                    <span className="shrink-0 tabular-nums">{f.units}</span>
                  </li>
                ))}
                {row.extras.map((e) => (
                  <li key={e.productId} className="flex items-start justify-between gap-3 px-3 py-2 bg-muted/50">
                    <span className="min-w-0">
                      {labelOf(e.productId)}
                      <span className="block text-xs text-muted-foreground">{t("notOnList")}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{e.units}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">{t("salesThatDay")}</h3>
            <DataTable
              columns={columns}
              data={results}
              getRowId={(sale) => sale._id}
              emptyMessage={t("noSalesShown")}
              pagination={{ mode: "server", ...pagination }}
              renderExpanded={(sale) => <SaleDetails sale={sale} service={service} onRequestEdit={onRequestEdit} />}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
