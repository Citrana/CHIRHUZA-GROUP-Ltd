import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { StockNav } from "@/components/stock/stock-nav";
import { StockBatchesPanel } from "@/components/stock/stock-batches-panel";

type Props = PageProps<"/[locale]/[service]/stock/batches">;

/** Purchase batches bought abroad. */
export default async function StockBatchesPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <StockNav service={service} />
      <StockBatchesPanel service={service} />
    </div>
  );
}
