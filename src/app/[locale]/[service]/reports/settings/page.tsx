import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { ReportSettingsPanel } from "@/components/reports/report-settings-panel";

type Props = PageProps<"/[locale]/[service]/reports/settings">;

/** The caller's scheduled report for this service. */
export default async function ReportSettingsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ReportSettingsPanel service={service} />;
}
