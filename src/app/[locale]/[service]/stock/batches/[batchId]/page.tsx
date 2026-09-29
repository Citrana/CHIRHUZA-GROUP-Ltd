import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../../convex/lib/businessUnits";
import { StockBatchDetail } from "@/components/stock/stock-batch-detail";

type Props = PageProps<"/[locale]/[service]/stock/batches/[batchId]">;

export default async function StockBatchPage({ params }: Props) {
  const { service, batchId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <StockBatchDetail service={service} batchId={batchId} />;
}
