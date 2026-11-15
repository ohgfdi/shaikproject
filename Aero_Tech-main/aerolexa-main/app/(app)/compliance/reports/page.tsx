import Link from "next/link";

import { MonthlyReportView } from "@/components/compliance/monthly-report-view";
import { PrintButton } from "@/components/compliance/print-button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guard";
import { isReportMonth } from "@/lib/engine/compliance-report";
import { getMonthlyComplianceReport } from "@/lib/server/compliance-report";
import { listOrganizationEngagements } from "@/lib/server/organization";

export const metadata = { title: "Compliance reports" };
export const dynamic = "force-dynamic";

/**
 * The client-facing month: what was due, what was filed, what it cost to be
 * late. Server-rendered from the same calendar and filing runs the board uses.
 */
export default async function ComplianceReportsPage(props: {
  searchParams: Promise<{ engagementId?: string; month?: string }>;
}) {
  const ctx = await requirePageAuth();
  const params = await props.searchParams;
  const engagements = await listOrganizationEngagements(ctx);

  const month =
    params.month && isReportMonth(params.month) ? params.month : new Date().toISOString().slice(0, 7);
  const engagementId = params.engagementId ?? engagements[0]?.id ?? "";

  let report = null;
  let error: string | null = null;
  if (engagementId) {
    try {
      report = await getMonthlyComplianceReport(ctx, { engagementId, month });
    } catch (err) {
      error = err instanceof Error ? err.message : "The report could not be prepared.";
    }
  }

  return (
    <div>
      <PageHeader
        title="Compliance reports"
        description="One client-month, ready to send: obligations, on-time and late filings, the ARN/proof digest behind each filed return, and the late-filing exposure the firm avoided — or did not."
      />

      <Card className="mt-6">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Client</span>
              <select
                name="engagementId"
                defaultValue={engagementId}
                className="h-9 min-w-[260px] rounded-md border bg-background px-3 text-sm"
              >
                {engagements.map((engagement) => (
                  <option key={engagement.id} value={engagement.id}>
                    {engagement.name}
                    {engagement.code ? ` (${engagement.code})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Month</span>
              <input
                type="month"
                name="month"
                defaultValue={month}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
            </label>
            <button className="h-9 rounded-md border bg-background px-4 text-sm font-medium" type="submit">
              Show report
            </button>
          </form>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/compliance/filings"
              className="text-sm text-accent underline underline-offset-2"
            >
              Filing runs
            </Link>
            {report ? <PrintButton /> : null}
          </div>
        </CardContent>
      </Card>

      <div className="mt-6">
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : report ? (
          <MonthlyReportView report={report} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Create a client engagement to produce a compliance report.
          </p>
        )}
      </div>
    </div>
  );
}
