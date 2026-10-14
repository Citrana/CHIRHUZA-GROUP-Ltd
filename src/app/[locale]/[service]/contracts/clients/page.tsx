import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../../convex/lib/transport";
import { ClientsPanel } from "@/components/fleet/clients-panel";
import { ContractsNav } from "@/components/fleet/contracts-nav";

type Props = PageProps<"/[locale]/[service]/contracts/clients">;

/** The saved clients - companies and people (Transport only). */
export default async function ClientsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <ContractsNav service={service} />
      <ClientsPanel service={service} />
    </div>
  );
}
