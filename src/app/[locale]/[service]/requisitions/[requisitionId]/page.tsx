import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { RequisitionDetail } from "@/components/requisitions/requisition-detail";

type Props = PageProps<"/[locale]/[service]/requisitions/[requisitionId]">;

export default async function RequisitionPage({ params }: Props) {
  const { service, requisitionId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <RequisitionDetail service={service} requisitionId={requisitionId} />;
}
