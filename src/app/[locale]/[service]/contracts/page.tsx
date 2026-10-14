import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { FLEET_SERVICES } from "../../../../../convex/lib/transport";
import { routing } from "@/i18n/routing";
import { ContractsNav } from "@/components/fleet/contracts-nav";

type Props = PageProps<"/[locale]/[service]/contracts">;

/** Overrides the `[module]` placeholder: contracts (Transport only). The list comes next. */
export default async function ContractsPage({ params }: Props) {
  const { locale, service } = await params;
  if (!hasLocale(routing.locales, locale) || !isBusinessUnitKey(service) || !FLEET_SERVICES.includes(service)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("Contracts");
  return (
    <div className="flex flex-col gap-6">
      <ContractsNav service={service} />
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("comingNext")}</p>
      </div>
    </div>
  );
}
