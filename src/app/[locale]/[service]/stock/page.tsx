import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { StockBatchesPanel } from "@/components/stock/stock-batches-panel";

type Props = PageProps<"/[locale]/[service]/stock">;

/** Overrides the `[module]` placeholder: purchase batches for now. */
export default async function StockPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <StockBatchesPanel service={service} />;
}
