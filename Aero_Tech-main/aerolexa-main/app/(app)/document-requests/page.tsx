import { DocumentRequestsWorkspace } from "@/components/ca/document-requests-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";

export const metadata = { title: "Document Requests" };

/**
 * Chasing clients for missing documents — the single most common beginner task
 * that had no home in the product: requests, deadlines, reminder counts and a
 * one-click chase, with the reminder email going out when an address is on file.
 */
export default async function DocumentRequestsPage() {
  await requirePageAuth();

  return (
    <div>
      <PageHeader
        title="Document requests"
        description="What each client still owes the firm: the document, its period, the deadline and how many times they have been chased. A reminder records the chase and emails the client when an address is on file."
      />
      <div className="mt-6">
        <DocumentRequestsWorkspace />
      </div>
    </div>
  );
}
