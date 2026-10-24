import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { StockNav } from "@/components/stock/stock-nav";
import { StockCountsPanel } from "@/components/stock/stock-counts-panel";

type Props = PageProps<"/[locale]/[service]/stock/counts">;

/** Stock counts: start one, and the history of past counts. */
export default async function StockCountsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <StockNav service={service} />
      <StockCountsPanel service={service} />
    </div>
  );
}
