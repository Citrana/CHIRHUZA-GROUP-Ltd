import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { RolePermissionsEditor } from "@/components/admin/role-permissions-editor";

type Props = PageProps<"/[locale]/admin/roles/[roleId]">;

export default async function AdminRolePage({ params }: Props) {
  const { locale, roleId } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-8">
      <RolePermissionsEditor roleId={roleId} />
    </main>
  );
}
