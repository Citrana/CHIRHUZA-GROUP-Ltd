import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { UsersAdminPanel } from "@/components/admin/users-admin-panel";

type Props = PageProps<"/[locale]/admin/users">;

export default async function AdminUsersPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-8">
      <UsersAdminPanel />
    </main>
  );
}
