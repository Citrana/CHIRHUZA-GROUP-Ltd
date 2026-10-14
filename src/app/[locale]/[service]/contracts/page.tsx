import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../convex/lib/transport";
import { ContractsNav } from "@/components/fleet/contracts-nav";
import { ContractsPanel } from "@/components/fleet/contracts-panel";

type Props = PageProps<"/[locale]/[service]/contracts">;

/** Overrides the `[module]` placeholder: the contracts (Transport only). */
export default async function ContractsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <ContractsNav service={service} />
      <ContractsPanel service={service} />
    </div>
  );
}
