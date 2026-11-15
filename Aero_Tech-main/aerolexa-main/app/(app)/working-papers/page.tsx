import { WorkingPapersWorkspace } from "@/components/ca/working-papers-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Working Papers" };

/**
 * Audit file workspace. The SA 230 binder index, the prepare → review →
 * sign-off ladder and the immutable version chain were reachable only from
 * Settings → Governance; a junior doing vouching should not have to open the
 * firm's governance screen to file a working paper.
 */
export default async function WorkingPapersPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Working papers"
        description="The audit file per client engagement — numbered working papers against the SA 230 index, prepared, reviewed and signed off, with the binder telling you which references are still missing."
      />
      <div className="mt-6">
        <WorkingPapersWorkspace />
      </div>
    </div>
  );
}
