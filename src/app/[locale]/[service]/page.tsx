import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../convex/lib/businessUnits";
import { ServiceHome } from "@/components/shell/service-home";

type Props = PageProps<"/[locale]/[service]">;

export default async function ServiceHomePage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ServiceHome service={service} />;
}
