import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { ProductsNav } from "@/components/products/products-nav";
import { ProductsPanel } from "@/components/products/products-panel";

type Props = PageProps<"/[locale]/[service]/products">;

/** Overrides the `[module]` placeholder for this service's products. */
export default async function ProductsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return (
    <div className="flex flex-col gap-6">
      <ProductsNav service={service} />
      <ProductsPanel service={service} />
    </div>
  );
}
