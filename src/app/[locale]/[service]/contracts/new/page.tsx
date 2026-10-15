import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../../convex/lib/transport";
import { ContractForm } from "@/components/fleet/contract-form";

type Props = PageProps<"/[locale]/[service]/contracts/new">;

/** The new contract form (Transport only). */
export default async function NewContractPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return <ContractForm service={service} />;
}
