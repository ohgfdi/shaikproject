import { PageHeader } from "@/components/layout/page-header";
import { EngagementsWorkspace } from "@/components/practice/engagements-workspace";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Engagements" };

/**
 * The partner's client workspace. The engagement API and models existed but
 * had no screen: working papers were reachable, the client itself was not.
 * This is the cross-client view — team, review queue, changes, deliverables
 * and retention in one place.
 */
export default async function EngagementsPage() {
  const _ctx = await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Engagements"
        description="Every client engagement in the firm — who is on it, what is waiting for review, what is signed off, and what has gone quiet. Open a client to see its team, review queue, change requests and deliverables."
      />
      <div className="mt-6">
        <EngagementsWorkspace />
      </div>
    </div>
  );
}
