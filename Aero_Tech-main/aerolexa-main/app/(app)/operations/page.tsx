import { OperationsWorkspace } from "@/components/ca/operations-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Firm Operations" };

/**
 * What the partner opens on Monday: what is late, who owns it, how old it is.
 * Counted from the statutory calendar, the filing board and document requests.
 */
export default async function OperationsPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Firm operations"
        description="Deadline breaches, aging and workload across every client — counted from the statutory calendar, filing runs and open document requests, with no invented utilisation figures."
      />
      <div className="mt-6">
        <OperationsWorkspace />
      </div>
    </div>
  );
}
