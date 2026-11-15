import { CaComputeWorkspace } from "@/components/ca/ca-compute-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "CA Compute" };

/**
 * CA computation workspace: the direct-tax engines that previously had no UI
 * (salary head, house property, capital gains, ITR computation and advance tax)
 * exposed behind POST /api/ca/compute. Every figure is computed by the engine and
 * returns with its own methodology trace — nothing here invents a number.
 */
export default async function CaComputePage() {
  await requirePageAuth();
  return (
    <div>
      <PageHeader
        title="CA Compute"
        description="Direct-tax computations for a client: salary u/s 17, house property, capital gains, the ITR summary and the advance-tax instalment position with interest u/s 234B/234C/234A. Amounts are entered in rupees; every result carries its computation trail."
      />
      <div className="mt-6">
        <CaComputeWorkspace />
      </div>
    </div>
  );
}
