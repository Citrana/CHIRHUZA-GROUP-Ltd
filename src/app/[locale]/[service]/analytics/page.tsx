import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { AnalyticsPanel } from "@/components/analytics/analytics-panel";

type Props = PageProps<"/[locale]/[service]/analytics">;

/** Overrides the `[module]` placeholder: the service's analytics. */
export default async function AnalyticsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <AnalyticsPanel service={service} />;
}
