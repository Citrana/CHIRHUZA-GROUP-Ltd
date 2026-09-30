import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { ProductsNav } from "@/components/products/products-nav";
import { PriceListPanel } from "@/components/products/price-list-panel";

type Props = PageProps<"/[locale]/[service]/products/prices">;

/** Selling prices next to purchase prices, per product. */
export default async function PricesPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <ProductsNav service={service} />
      <PriceListPanel service={service} />
    </div>
  );
}
