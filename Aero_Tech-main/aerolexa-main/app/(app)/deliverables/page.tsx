import { DeliverablesHub } from "@/components/deliverables/deliverables-hub";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Deliverables" };

/**
 * The deliverable register. Assembly, review, sign-off, issuance and UDIN
 * minting already existed behind the engagement API; without this screen the
 * client portal had nothing to publish and partners had no cross-client view.
 */
export default async function DeliverablesPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Deliverables"
        description="Every client deliverable across the firm — assembled, reviewed, signed off and issued, with the UDIN minted at issuance. Issued client copies are what the client portal publishes."
      />
      <div className="mt-6">
        <DeliverablesHub />
      </div>
    </div>
  );
}
