import { NoticesWorkspace } from "@/components/ca/notices-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Notices" };

/**
 * Notice register. Every notice is stored with its reply deadline, demand and
 * reply history, which is the part a firm cannot do from a spreadsheet without
 * losing a date.
 */
export default async function NoticesPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Notices & replies"
        description="Record GST notices (ASMT, DRC, ADT, CMP, refund and registration) with the officer, demand and reply deadline; draft a structured reply from the notice facts and keep every saved draft against the notice."
      />
      <div className="mt-6">
        <NoticesWorkspace />
      </div>
    </div>
  );
}
