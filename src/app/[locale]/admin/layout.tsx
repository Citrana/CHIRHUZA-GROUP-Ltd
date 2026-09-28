import { AppHeader } from "@/components/shell/app-header";

/** Admin pages sit outside any service, with a link back to the last one. */
export default function AdminLayout({ children }: LayoutProps<"/[locale]/admin">) {
  return (
    <>
      <AppHeader backToLastService />
      {children}
    </>
  );
}
