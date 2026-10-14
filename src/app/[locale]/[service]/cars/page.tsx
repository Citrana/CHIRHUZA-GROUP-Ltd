import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../convex/lib/transport";
import { CarsPanel } from "@/components/fleet/cars-panel";
import { FleetNav } from "@/components/fleet/fleet-nav";

type Props = PageProps<"/[locale]/[service]/cars">;

/** Overrides the `[module]` placeholder: the fleet (Transport only). */
export default async function CarsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <FleetNav service={service} />
      <CarsPanel service={service} />
    </div>
  );
}
