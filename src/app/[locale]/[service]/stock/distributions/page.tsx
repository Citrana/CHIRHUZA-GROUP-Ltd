import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { StockNav } from "@/components/stock/stock-nav";
import { DistributionsPanel } from "@/components/stock/distributions-panel";

type Props = PageProps<"/[locale]/[service]/stock/distributions">;

/** Stock sent from the business to shops and people. */
export default async function DistributionsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <StockNav service={service} />
      <DistributionsPanel service={service} />
    </div>
  );
}
