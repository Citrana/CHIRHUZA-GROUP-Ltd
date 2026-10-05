import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { StockNav } from "@/components/stock/stock-nav";
import { StockOverview } from "@/components/stock/stock-overview";

type Props = PageProps<"/[locale]/[service]/stock">;

/** Overrides the `[module]` placeholder: what's on hand, by product, lot and holder. */
export default async function StockPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <StockNav service={service} />
      <StockOverview service={service} />
    </div>
  );
}
