import { GstReconWorkspace } from "@/components/ca/gst-recon-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "GST Reconciliation" };

/**
 * The product wedge, finally exposed: reconcile a purchase register against
 * GSTR-2B and produce GSTR-3B Table 4. Backed by POST /api/gst/itc-recon.
 *
 * The page is a compute surface, not a portal integration: the caller supplies
 * both sides (the 2B rows are mapped from the portal export), and the response
 * carries the engine's methodology. Nothing is persisted — client tax data is
 * deliberately not written to localStorage or the server.
 */
export default async function GstReconPage() {
  await requirePageAuth();
  return (
    <div>
      <PageHeader
        title="GST Reconciliation"
        description="Match a purchase register against GSTR-2B invoice by invoice, then read the GSTR-3B Table 4 figure the engine derives: 4(A) availed, 4(B)(1) reversals and 4(C) net ITC. Both sides are rows you provide — this tool never calls the GST portal."
      />
      <div className="mt-6">
        <GstReconWorkspace />
      </div>
    </div>
  );
}
