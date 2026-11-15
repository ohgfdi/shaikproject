import type { ReactNode } from "react";

import { Badge, Card, CardContent } from "@/components/ui/primitives";
import type { MonthlyComplianceReport, ReportRow } from "@/lib/engine/compliance-report";

const OUTCOME: Record<
  ReportRow["outcome"],
  { label: string; variant: "success" | "warning" | "critical" | "default" | "outline" }
> = {
  "filed-on-time": { label: "Filed on time", variant: "success" },
  "filed-late": { label: "Filed late", variant: "warning" },
  overdue: { label: "Overdue", variant: "critical" },
  pending: { label: "Not yet due", variant: "default" },
  waived: { label: "Waived", variant: "outline" },
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(`${iso.length === 10 ? `${iso}T00:00:00Z` : iso}`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/**
 * The report body. Server-rendered so it prints and saves to PDF with no
 * JavaScript, and shared by the firm screen and the client portal.
 */
export function MonthlyReportView({
  report,
  actions,
  heading = "Compliance report",
}: {
  report: MonthlyComplianceReport;
  actions?: ReactNode;
  heading?: string;
}) {
  const t = report.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {heading} — {report.month}
          </h2>
          <p className="text-sm text-muted-foreground">
            {report.engagement.name} · prepared as at {fmtDate(report.asOf)}
          </p>
        </div>
        {actions}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">{t.due} due</Badge>
        <Badge variant="success">{t.onTime} on time</Badge>
        <Badge variant={t.late > 0 ? "warning" : "outline"}>{t.late} late</Badge>
        <Badge variant={t.overdue > 0 ? "critical" : "outline"}>{t.overdue} overdue</Badge>
        <Badge variant="outline">{t.pending} not yet due</Badge>
        {t.waived > 0 ? <Badge variant="outline">{t.waived} waived</Badge> : null}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Obligation</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 font-medium">Filed</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Proof</th>
                <th className="px-3 py-2 text-right font-medium">Exposure</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-muted-foreground" colSpan={6}>
                    No statutory obligation fell due in {report.month}.
                  </td>
                </tr>
              ) : (
                report.rows.map((row) => {
                  const outcome = OUTCOME[row.outcome];
                  const exposure = row.exposure;
                  return (
                    <tr key={row.taskId} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-medium">{row.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.authority} · {row.code}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{fmtDate(row.dueDate)}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {fmtDate(row.filedDate)}
                        {row.daysLate > 0 ? (
                          <span className="text-xs text-muted-foreground"> ({row.daysLate}d late)</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={outcome.variant}>{outcome.label}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.reference ? <p>{row.reference}</p> : null}
                        {row.proofDigest ? (
                          <p className="text-muted-foreground" title={row.proofDigest}>
                            digest {row.proofDigest.slice(0, 10)}…
                          </p>
                        ) : null}
                        {row.clientApprovedAt ? (
                          <p className="text-muted-foreground">client approved</p>
                        ) : null}
                        {!row.reference && !row.proofDigest ? "—" : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {exposure.totalMinor === null ? (
                          <span className="text-xs text-muted-foreground">not estimated</span>
                        ) : (
                          <>
                            <p>{exposure.totalMinor === 0 ? "—" : money(exposure.totalMinor)}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {exposure.basis === "exact"
                                ? "exact"
                                : exposure.basis === "upper-bound"
                                  ? "maximum"
                                  : exposure.basis === "partial"
                                    ? "fee only"
                                    : "estimate"}
                            </p>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <h3 className="text-sm font-semibold">What this month says</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {report.narrative.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <details className="pt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Rules applied to the exposure column</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>GST late fee ₹50/day, capped at ₹5,000 (₹2,000 for a nil return); interest u/s 50 at 18% p.a. only when the tax paid late is recorded.</li>
              <li>TDS fee u/s 234E ₹200/day, capped at the TDS amount; 201(1A) interest is computed by the TDS suite.</li>
              <li>Income-tax interest u/s 234A at 1% per month or part month on unpaid tax; the s.234F fee is not included.</li>
              <li>Companies Act, professional-tax and advance-tax late consequences are not estimated — they use different schedules.</li>
            </ul>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
