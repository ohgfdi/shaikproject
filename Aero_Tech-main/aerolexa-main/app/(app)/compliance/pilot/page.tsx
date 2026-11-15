import { FilingPilotView } from "@/components/compliance/filing-pilot";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Filing pilot" };

/**
 * The path from "the gateway is implemented" to "a filing is proven". Shows
 * configuration, transmitted evidence and the exact next action.
 */
export default async function FilingPilotPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Filing pilot"
        description="What the gateway is configured to do, what has actually been transmitted, and what is still missing before this deployment can call a filing certified."
      />
      <div className="mt-6">
        <FilingPilotView />
      </div>
    </div>
  );
}
