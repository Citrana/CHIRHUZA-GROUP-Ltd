"use client";

import { useState } from "react";
import { FilePlus2, Settings } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link, useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { GenerateReportDialog } from "@/components/reports/generate-report-dialog";
import { formatDay } from "@/lib/report-pdf";
import { useCan } from "@/lib/use-can";

type ReportRow = PaginatedQueryItem<typeof api.reports.list>;

/** Saved reports (scheduled and custom), newest first; generate one; link to settings. */
export function ReportsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Reports");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("reports.view");
  const canGenerate = useCan("reports.generate");
  const canSettings = useCan("reports.settings");
  const [generateOpen, setGenerateOpen] = useState(false);
  const { results, pagination } = useCursorPaginatedQuery(api.reports.list, canView ? { businessUnitKey: service } : "skip");

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const period = (r: ReportRow) => `${formatDay(r.from, locale)} – ${formatDay(r.to, locale)}`;
  const status = (r: ReportRow) => (
    <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>{t(`statuses.${r.status}`)}</Badge>
  );
  const open = (r: ReportRow) => router.push(`/${service}/reports/${r._id}`);

  const columns: DataTableColumn<ReportRow>[] = [
    { id: "period", header: t("periodHeader"), cell: ({ row }) => <span className="font-medium">{period(row.original)}</span> },
    { id: "kind", header: t("typeHeader"), cell: ({ row }) => t(`kinds.${row.original.kind}`) },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => status(row.original) },
    { id: "made", header: t("madeHeader"), cell: ({ row }) => when.format(row.original.generatedAt), meta: { hideBelow: "lg" } },
    { id: "by", header: t("byHeader"), cell: ({ row }) => row.original.createdByName, meta: { hideBelow: "lg" } },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSettings ? (
            <Link href={`/${service}/reports/settings`} className={buttonVariants({ variant: "outline", size: "lg", className: "min-h-11" })}>
              <Settings aria-hidden />
              {t("settingsLink")}
            </Link>
          ) : null}
          {canGenerate ? (
            <Button size="lg" className="min-h-11" onClick={() => setGenerateOpen(true)}>
              <FilePlus2 aria-hidden />
              {t("generate")}
            </Button>
          ) : null}
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="reports-history">
        <h2 id="reports-history" className="font-heading text-lg font-semibold">
          {t("historyTitle")}
        </h2>
        <DataTable
          columns={columns}
          data={results}
          getRowId={(r) => r._id}
          emptyMessage={t("empty")}
          pagination={{ mode: "server", ...pagination }}
          onRowClick={open}
          renderCard={(r) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{period(r)}</span>
                {status(r)}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(`kinds.${r.kind}`)} · {when.format(r.generatedAt)} · {r.createdByName}
              </p>
            </div>
          )}
        />
      </section>

      {canGenerate ? (
        <GenerateReportDialog
          service={service}
          open={generateOpen}
          onOpenChange={setGenerateOpen}
          onGenerated={(reportId) => router.push(`/${service}/reports/${reportId}`)}
        />
      ) : null}
    </div>
  );
}
