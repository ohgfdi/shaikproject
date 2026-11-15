import { PageHeader } from "@/components/layout/page-header";
import { StatutesPanel } from "@/components/settings/statutes-panel";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Rule & Rate Registry" };

export default async function StatutesPage() {
  // Page-level guard as well as the middleware prefix: the middleware verifies
  // the session signature only, so the shell must not render for an anonymous
  // visitor even if the cookie still verifies.
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Rule & Rate Registry"
        description="The statutory rules this firm computes from — slabs, rates, thresholds and due-date windows — with the version in force on any date, the authority that published it and the notification it came from."
      />
      <div className="mt-6">
        <StatutesPanel />
      </div>
    </div>
  );
}
