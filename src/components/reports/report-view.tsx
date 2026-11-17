"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, Download, Lightbulb, TrendingDown, TrendingUp } from "lucide-react";
import { useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { deltaTone, percentChange } from "../../../convex/lib/analyticsCompare";
import { MAX_LISTED_MISSING_DAYS } from "../../../convex/lib/reports";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { renderPdf } from "@/lib/pdf/document";
import {
  formatDay,
  formatDayRanges,
  highlightTexts,
  reportPdfContent,
  stockItemLabel,
  type ReportForView,
} from "@/lib/report-pdf";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type StockItem = NonNullable<ReportForView["content"]["stock"]>["low"][number];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby={`report-${id}`}>
      <h2 id={`report-${id}`} className="font-heading text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Figure({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function Note({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <p className={cn("text-xs", warn ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{children}</p>;
}

/** ▲/▼ with its colour: green good news, red bad (a cost going down is good). */
function Change({ now, before, inverse = false }: { now: number; before: number; inverse?: boolean }) {
  const pct = percentChange(now, before);
  if (pct === null) return <span className="text-xs text-muted-foreground">—</span>;
  const tone = deltaTone(pct, { inverse });
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs", tone === "good" && "text-primary", tone === "bad" && "text-destructive")}>
      {pct > 0 ? <TrendingUp className="size-3.5" aria-hidden /> : pct < 0 ? <TrendingDown className="size-3.5" aria-hidden /> : null}
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

/** One saved report: highlights, then every section the viewer may see, and its PDF. */
export function ReportView({ service, reportId }: { service: BusinessUnitKey; reportId: string }) {
  const t = useTranslations("Reports");
  const tTypes = useTranslations("Approvals.types");
  const tProducts = useTranslations("Products");
  const tUnits = useTranslations("BusinessUnits");
  const locale = useLocale();
  const canView = useCan("reports.view");
  const report = useQuery(api.reports.get, canView ? { reportId: reportId as Id<"reports"> } : "skip");
  const me = useQuery(api.users.getCurrentUser);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(false);

  const back = (
    <Link href={`/${service}/reports`} className={buttonVariants({ variant: "ghost", className: "min-h-11 self-start" })}>
      <ArrowLeft aria-hidden />
      {t("back")}
    </Link>
  );
  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  if (report === undefined) return null;
  if (report === null || report.businessUnitKey !== service) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  }

  const tr = (key: string, values?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], values);
  const money = (cents: number, currency: "USD" | "CDF" = "USD") => formatMoney(cents, currency, locale);
  const day = (d: string) => formatDay(d, locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const inches = (n: number) => tProducts("inches", { inches: n });
  const c = report.content;
  const highlights = highlightTexts(c, tr, locale);

  async function downloadPdf() {
    if (!report) return;
    setPdfBusy(true);
    setPdfError(false);
    try {
      const content = reportPdfContent(report, {
        t: tr,
        tApprovalType: (type) => tTypes(type as Parameters<typeof tTypes>[0]),
        inches,
        locale,
        serviceKey: service,
        serviceName: tUnits(service),
        downloadedBy: me?.name || me?.email || "-",
        now: Date.now(),
      });
      await renderPdf(content, (page, pages) => t("pdf.page", { page, pages }));
    } catch {
      setPdfError(true);
    } finally {
      setPdfBusy(false);
    }
  }

  const hasReorder = c.stock ? [...c.stock.low, ...c.stock.out].some((i) => i.reorderQty !== undefined) : false;
  const stockList = (items: StockItem[], total: number, out: boolean) =>
    items.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <ul className="flex flex-col divide-y divide-border text-sm">
          {items.map((i) => (
            <li key={i.productId} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">{stockItemLabel(i, inches)}</span>
                <span className="block text-xs text-muted-foreground">
                  {i.sku}
                  {hasReorder ? ` · ${t("stock.sold30")}: ${i.sold30 ?? 0}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
                <span className="text-muted-foreground">
                  {out ? (i.outOfStockSince !== null ? date.format(i.outOfStockSince) : "—") : `${t("stock.onHand")}: ${i.onHand}`}
                </span>
                {hasReorder && (i.reorderQty ?? 0) > 0 ? (
                  <span className="text-xs font-semibold">
                    {t("stock.reorder")}: {i.reorderQty}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {total > items.length ? <Note>{t("stock.more", { shown: items.length, total })}</Note> : null}
      </div>
    );

  const f = c.sales?.figures;
  const prev = c.sales?.previous ?? null;
  const missingCount = c.sales?.missingDaysCount ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("reportTitle", { from: day(report.from), to: day(report.to) })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(`kinds.${report.kind}`)} · {report.createdByName}
          </p>
          <p className="mt-1 text-sm font-medium">{t("basedOn", { date: when.format(report.generatedAt) })}</p>
        </div>
        <Button variant="outline" size="lg" className="min-h-11" onClick={downloadPdf} disabled={pdfBusy}>
          <Download aria-hidden />
          {pdfBusy ? t("preparing") : t("download")}
        </Button>
      </div>
      {pdfError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("downloadError")}
        </p>
      ) : null}

      {report.status === "failed" ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="status">
          <p className="font-medium text-destructive">{t("failedTitle")}</p>
          <p className="mt-1 text-muted-foreground">{t("failedBody")}</p>
        </div>
      ) : null}

      {highlights.length > 0 ? (
        <section className="rounded-lg border border-accent bg-accent/40 p-4" aria-labelledby="report-highlights">
          <h2 id="report-highlights" className="flex items-center gap-2 font-heading text-lg font-semibold">
            <Lightbulb className="size-5 text-primary" aria-hidden />
            {t("highlights.title")}
          </h2>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm">
            {highlights.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {c.sales ? (
        <Section id="sales" title={t("sections.sales")}>
          <p className="text-3xl font-semibold tabular-nums">{money(f?.sales ?? c.sales.total)}</p>
          {f ? (
            <div className="flex flex-col gap-1.5">
              {(
                [
                  ["margin", f.margin, prev?.margin, false],
                  ["expenses", f.expenses, prev?.expenses, true],
                  ["payroll", f.payroll, prev?.payroll, true],
                  ["netProfit", f.netProfit, prev?.netProfit, false],
                ] as const
              ).map(([key, now, before, inverse]) => (
                <Figure
                  key={key}
                  label={t(`sales.${key}`)}
                  value={
                    <span className="inline-flex items-baseline gap-2">
                      {money(now)}
                      {prev ? <Change now={now} before={before ?? 0} inverse={inverse} /> : null}
                    </span>
                  }
                  className={key === "netProfit" ? "border-t border-border pt-1.5" : undefined}
                />
              ))}
              <Figure label={t("sales.withdrawals")} value={money(f.withdrawals)} className="mt-2" />
              <Note>{t("sales.withdrawalsNote")}</Note>
            </div>
          ) : null}
          {prev && c.sales.compareFrom && c.sales.compareTo ? (
            <div className="flex flex-col gap-1.5">
              <Figure
                label={t("sales.previous", { from: day(c.sales.compareFrom), to: day(c.sales.compareTo) })}
                value={
                  <span className="inline-flex items-baseline gap-2">
                    {money(prev.sales)}
                    <Change now={f?.sales ?? c.sales.total} before={prev.sales} />
                  </span>
                }
              />
            </div>
          ) : c.sales.compareFrom && c.sales.previousTotal !== null ? (
            // A report saved before the detailed figures existed.
            <Figure
              label={t("sales.previous", { from: day(c.sales.compareFrom), to: day(c.sales.compareTo ?? c.sales.compareFrom) })}
              value={
                <span className="inline-flex items-baseline gap-2">
                  {money(c.sales.previousTotal)}
                  <Change now={c.sales.total} before={c.sales.previousTotal} />
                </span>
              }
            />
          ) : null}
          {missingCount > 0 ? <Note warn>{t("sales.understated", { count: missingCount })}</Note> : null}

          {c.sales.byShop && c.sales.byShop.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="mt-2 text-sm font-medium">{t("sales.byShop")}</h3>
              {c.sales.byShop.map((s) => (
                <Figure key={s.locationId} label={s.name} value={money(s.sales)} />
              ))}
            </div>
          ) : null}

          {c.sales.topProducts ? (
            <div className="flex flex-col gap-1">
              <h3 className="mt-2 text-sm font-medium">{t("sales.topProducts")}</h3>
              {c.sales.topProducts.length === 0 ? (
                <Note>{t("sales.noTopProducts")}</Note>
              ) : (
                <ol className="flex flex-col divide-y divide-border text-sm">
                  {c.sales.topProducts.map((p, i) => (
                    <li key={p.productId} className="flex items-start justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {i + 1}. {stockItemLabel(p, inches)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t("sales.units")}: {p.unitsSold} · {t("sales.margin")}: {money(p.margin)}
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums">{money(p.revenue)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : null}
        </Section>
      ) : null}

      {c.missingDays ? (
        <Section id="missing" title={t("sections.missingDays")}>
          {c.missingDays.count === 0 ? (
            <p className="text-sm text-muted-foreground">{t("missing.none")}</p>
          ) : (
            <>
              <p className="text-sm font-medium">{t("missing.count", { count: c.missingDays.count })}</p>
              <ul className="flex flex-col divide-y divide-border text-sm">
                {c.missingDays.shops.map((s) => (
                  <li key={s.locationId} className="flex flex-col gap-0.5 py-2">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{s.name}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{t("missing.shopCount", { count: s.count ?? s.days.length })}</span>
                    </span>
                    <span className="text-muted-foreground">{formatDayRanges(s.days, locale)}</span>
                  </li>
                ))}
              </ul>
              {c.missingDays.shops.some((s) => s.truncated) ? <Note>{t("missing.latest", { count: MAX_LISTED_MISSING_DAYS })}</Note> : null}
            </>
          )}
          <Note>{t("missing.hint")}</Note>
        </Section>
      ) : null}

      {c.stock ? (
        <Section id="stock" title={t("sections.stock")}>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("stock.lowCount")}</p>
              <p className="text-lg font-semibold tabular-nums">{c.stock.lowCount}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("stock.outCount")}</p>
              <p className="text-lg font-semibold tabular-nums">{c.stock.outCount}</p>
            </div>
          </div>
          {c.stock.value !== undefined ? (
            <div className="flex flex-col gap-1.5">
              <Figure label={t("stock.value")} value={money(c.stock.value)} />
              {c.stock.unitsOnHand !== undefined ? <Figure label={t("stock.units")} value={c.stock.unitsOnHand} /> : null}
            </div>
          ) : null}
          {c.stock.lowCount + c.stock.outCount === 0 ? <p className="text-sm text-muted-foreground">{t("stock.none")}</p> : null}
          {c.stock.low.length > 0 ? <h3 className="text-sm font-medium">{t("stock.lowCount")}</h3> : null}
          {stockList(c.stock.low, c.stock.lowCount, false)}
          {c.stock.out.length > 0 ? <h3 className="text-sm font-medium">{t("stock.outCount")}</h3> : null}
          {stockList(c.stock.out, c.stock.outCount, true)}
          {hasReorder && c.stock.lowCount + c.stock.outCount > 0 ? <Note>{t("stock.reorderHint")}</Note> : null}
        </Section>
      ) : null}

      {c.approvals ? (
        <Section id="approvals" title={t("sections.approvals")}>
          {c.approvals.count === 0 ? (
            <p className="text-sm text-muted-foreground">{t("approvals.none")}</p>
          ) : c.approvals.items ? (
            <>
              <Figure label={t("approvals.count")} value={c.approvals.count} />
              <ul className="flex flex-col divide-y divide-border text-sm">
                {c.approvals.items.map((a) => (
                  <li key={a.approvalId} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block font-medium">{tTypes(a.type)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {a.requestedByName} · {date.format(a.requestedAt)}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{a.amount !== null ? money(a.amount, a.currency ?? "USD") : "—"}</span>
                  </li>
                ))}
              </ul>
              {c.approvals.count > c.approvals.items.length ? (
                <Note>{t("approvals.more", { shown: c.approvals.items.length, total: c.approvals.count })}</Note>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Figure label={t("approvals.count")} value={c.approvals.count} />
              {c.approvals.byType.map((a) => (
                <Figure key={a.type} label={tTypes(a.type)} value={a.count} className="pl-3" />
              ))}
            </div>
          )}
        </Section>
      ) : null}

      {c.credit ? (
        <Section id="credit" title={t("sections.credit")}>
          {c.credit.customers === 0 ? (
            <p className="text-sm text-muted-foreground">{t("credit.none")}</p>
          ) : (
            <>
              <Figure label={`${t("credit.total")} · ${t("credit.customers", { count: c.credit.customers })}`} value={money(c.credit.totalOwed)} />
              <ul className="flex flex-col divide-y divide-border text-sm">
                {c.credit.top.map((x) => (
                  <li key={x.customerId} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{x.name}</span>
                      {x.oldestUnpaidAt !== undefined ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("credit.oldest")}: {date.format(x.oldestUnpaidAt)} · {t("credit.days", { count: x.daysUnpaid ?? 0 })}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{money(x.balance)}</span>
                  </li>
                ))}
              </ul>
              {c.credit.top.some((x) => x.oldestUnpaidAt !== undefined) ? <Note>{t("credit.sortNote")}</Note> : null}
              {c.credit.customers > c.credit.top.length ? (
                <Note>{t("credit.more", { shown: c.credit.top.length, total: c.credit.customers })}</Note>
              ) : null}
            </>
          )}
        </Section>
      ) : null}

      {c.cash ? (
        <Section id="cash" title={t("sections.cash")}>
          <div className="flex flex-col gap-1.5">
            <Figure label={t("cash.onHand")} value={money(c.cash.onHand)} />
            <Figure
              label={`${t("cash.pending")} · ${t("cash.pendingCount", { count: c.cash.pendingOpeningCashCount })}`}
              value={money(c.cash.pendingOpeningCash)}
            />
          </div>
          <Note>{t("cash.hint")}</Note>
        </Section>
      ) : null}

      <Note>{t("asOfNote")}</Note>
    </div>
  );
}
