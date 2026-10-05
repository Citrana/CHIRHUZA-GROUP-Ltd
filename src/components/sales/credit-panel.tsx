"use client";

import { ArrowLeft } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link, useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCan } from "@/lib/use-can";

type Row = FunctionReturnType<typeof api.credit.owed>["rows"][number];

/**
 * Credit (sales.view): customers who still owe money, largest balance
 * first, with the total owed. Open a customer to record a payment.
 */
export function CreditPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Credit");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("sales.view");
  const owed = useQuery(api.credit.owed, canView ? { businessUnitKey: service } : "skip");

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });

  const columns: DataTableColumn<Row>[] = [
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: t("nameHeader"),
      enableSorting: true,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: "phone",
      accessorFn: (r) => r.phone ?? "",
      header: t("phoneHeader"),
      cell: ({ row }) => row.original.phone ?? "—",
      meta: { hideBelow: "sm", className: "text-muted-foreground" },
    },
    {
      id: "balance",
      accessorFn: (r) => r.balance,
      header: t("owesHeader"),
      enableSorting: true,
      cell: ({ row }) => money(row.original.balance),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    {
      id: "openSales",
      accessorFn: (r) => r.openSales,
      header: t("openSalesHeader"),
      enableSorting: true,
      meta: { hideBelow: "md", className: "tabular-nums" },
    },
    {
      id: "since",
      accessorFn: (r) => r.oldestSaleAt,
      header: t("sinceHeader"),
      enableSorting: true,
      cell: ({ row }) => day.format(row.original.oldestSaleAt),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/${service}/sales`}
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("backToSales")}
      </Link>
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <div className="rounded-lg border border-border p-3 sm:max-w-xs">
        <p className="text-xs text-muted-foreground">{t("totalOwed")}</p>
        <p className="text-xl font-semibold tabular-nums">{owed ? money(owed.totalOwed) : "…"}</p>
      </div>
      <DataTable
        columns={columns}
        data={owed?.rows}
        getRowId={(r) => r.customerId}
        emptyMessage={t("empty")}
        search={{ placeholder: t("searchPlaceholder") }}
        onRowClick={(r) => router.push(`/${service}/sales/credit/${r.customerId}`)}
        renderCard={(r) => (
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium">{r.name}</span>
              <span className="block text-xs text-muted-foreground">
                {[r.phone, t("openSales", { count: r.openSales })].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{money(r.balance)}</span>
          </div>
        )}
      />
    </div>
  );
}
