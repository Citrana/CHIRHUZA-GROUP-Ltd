import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../../convex/lib/transport";
import { DriversPanel } from "@/components/fleet/drivers-panel";
import { FleetNav } from "@/components/fleet/fleet-nav";

type Props = PageProps<"/[locale]/[service]/cars/drivers">;

/** The drivers of the fleet (Transport only). */
export default async function DriversPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <FleetNav service={service} />
      <DriversPanel service={service} />
    </div>
  );
}
