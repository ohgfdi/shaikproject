import { ComplianceCalendarWorkspace } from "@/components/compliance/compliance-calendar";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Compliance Calendar" };

/**
 * The firm's statutory calendar. Individual compute engines existed, but no
 * screen answered the daily question: what is due next week, for which client,
 * and has anyone filed it?
 */
export default async function CompliancePage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Compliance calendar"
        description="Every client's statutory due dates in one place — GST, TDS, advance tax, ITR, tax audit, ROC and professional tax — with the firm's filed state and the acknowledgement on record."
      />
      <div className="mt-6">
        <ComplianceCalendarWorkspace />
      </div>
    </div>
  );
}
