import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { ProductSettingsPanel } from "@/components/products/product-settings-panel";

type Props = PageProps<"/[locale]/[service]/settings">;

/** The service's product settings (lengths, colours), inside the app shell. */
export default async function ServiceSettingsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ProductSettingsPanel service={service} />;
}
