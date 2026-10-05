import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { RolesAdminPanel } from "@/components/admin/roles-admin-panel";

type Props = PageProps<"/[locale]/admin/roles">;

export default async function AdminRolesPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-4 md:p-8">
      <RolesAdminPanel />
    </main>
  );
}
