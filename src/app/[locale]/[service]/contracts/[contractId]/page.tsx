import { notFound } from "next/navigation";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../../convex/lib/transport";
import { ContractDetail } from "@/components/fleet/contract-detail";

type Props = PageProps<"/[locale]/[service]/contracts/[contractId]">;

/** One contract with its payments (Transport only). */
export default async function ContractPage({ params }: Props) {
  const { service, contractId } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return <ContractDetail service={service} contractId={contractId as Id<"contracts">} />;
}
