import { AppHeader } from "@/components/shell/app-header";
import { NewSaleFab } from "@/components/shell/new-sale-fab";

/**
 * Admin pages sit outside any service, with a link back to the last one
 * and the New sale button for it.
 */
export default function AdminLayout({ children }: LayoutProps<"/[locale]/admin">) {
  return (
    <>
      <AppHeader backToLastService />
      <div className="flex flex-1 flex-col pb-fab">{children}</div>
      <NewSaleFab />
    </>
  );
}
