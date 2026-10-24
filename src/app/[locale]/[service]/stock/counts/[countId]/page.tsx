import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../../convex/lib/businessUnits";
import { StockCountDetail } from "@/components/stock/stock-count-detail";

type Props = PageProps<"/[locale]/[service]/stock/counts/[countId]">;

/** One stock count: counting, review, or its result. */
export default async function StockCountPage({ params }: Props) {
  const { service, countId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <StockCountDetail service={service} countId={countId} />;
}
