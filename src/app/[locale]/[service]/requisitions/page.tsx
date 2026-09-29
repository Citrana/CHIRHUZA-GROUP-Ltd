import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { RequisitionsPanel } from "@/components/requisitions/requisitions-panel";

type Props = PageProps<"/[locale]/[service]/requisitions">;

/** Overrides the `[module]` placeholder for this service's requisitions. */
export default async function RequisitionsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <RequisitionsPanel service={service} />;
}
