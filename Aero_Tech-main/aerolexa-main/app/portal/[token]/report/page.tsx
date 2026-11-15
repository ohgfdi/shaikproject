import Link from "next/link";

import { MonthlyReportView } from "@/components/compliance/monthly-report-view";
import { PrintButton } from "@/components/compliance/print-button";
import { isReportMonth } from "@/lib/engine/compliance-report";
import { getPortalMonthlyComplianceReport } from "@/lib/server/compliance-report";

export const metadata = {
  title: "Compliance report",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The client's printable month. Reached through the same expiring portal token;
 * no firm navigation, no session, and nothing the portal snapshot would not
 * already show.
 */
export default async function PortalComplianceReportPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { token } = await props.params;
  const params = await props.searchParams;
  const month =
    params.month && isReportMonth(params.month) ? params.month : new Date().toISOString().slice(0, 7);

  let report = null;
  let error: string | null = null;
  try {
    report = await getPortalMonthlyComplianceReport(token, month);
  } catch (err) {
    error = err instanceof Error ? err.message : "The report could not be prepared.";
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/portal/${token}`} className="text-sm text-accent underline underline-offset-2">
          ← Back to your portal
        </Link>
        {report ? <PrintButton /> : null}
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : report ? (
        <MonthlyReportView report={report} heading="Your compliance report" />
      ) : null}
    </main>
  );
}
