import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { ApprovalsPanel } from "@/components/approvals/approvals-panel";

type Props = PageProps<"/[locale]/[service]/approvals">;

/** Overrides the `[module]` placeholder for this service's approvals. */
export default async function ApprovalsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ApprovalsPanel service={service} />;
}
