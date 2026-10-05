import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { LocationsAdminPanel } from "@/components/admin/locations-admin-panel";

type Props = PageProps<"/[locale]/admin/locations">;

export default async function AdminLocationsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 p-4 md:p-8">
      <LocationsAdminPanel />
    </main>
  );
}
