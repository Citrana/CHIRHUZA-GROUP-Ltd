import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { ReportView } from "@/components/reports/report-view";

type Props = PageProps<"/[locale]/[service]/reports/[reportId]">;

/** One saved report, with its PDF. */
export default async function ReportPage({ params }: Props) {
  const { service, reportId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ReportView service={service} reportId={reportId} />;
}
