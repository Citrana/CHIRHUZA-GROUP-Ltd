import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { ReportsPanel } from "@/components/reports/reports-panel";

type Props = PageProps<"/[locale]/[service]/reports">;

/** Overrides the `[module]` placeholder: saved reports and "Generate report". */
export default async function ReportsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ReportsPanel service={service} />;
}
