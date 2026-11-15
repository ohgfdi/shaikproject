import { TdsCreditWorkspace } from "@/components/ca/tds-credit-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "TDS Credit Reconciliation" };

/**
 * 26AS/AIS against the books. Backed by POST /api/ca/tds-credit-recon.
 *
 * A compute surface, not a TRACES integration: the caller supplies both
 * exports, and the response carries the verdicts and methodology. Nothing is
 * persisted.
 */
export default async function TdsReconPage() {
  await requirePageAuth();
  return (
    <div>
      <PageHeader
        title="TDS Credit Reconciliation"
        description="Match Form 26AS / AIS credits against the client's TDS receivable ledger. The engine separates unclaimed credit, unsupported claims, amount mismatches and duplicates, and says which differences must be fixed before the ITR is filed. It reconciles the exports you provide — it never logs in to TRACES."
      />
      <div className="mt-6">
        <TdsCreditWorkspace />
      </div>
    </div>
  );
}
