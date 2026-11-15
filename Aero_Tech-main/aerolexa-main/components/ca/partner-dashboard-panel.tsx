"use client";

import { AlertTriangle, Loader2, RefreshCw, Sparkles, TrendingUp, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { PartnerDashboard } from "@/lib/server/partner-dashboard";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function pct(value: number | null): string {
  return value === null ? "Not recorded" : `${value.toFixed(1)}%`;
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "critical" | "warning" | "success";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={
            "mt-1 text-2xl font-semibold " +
            (tone === "critical"
              ? "text-destructive"
              : tone === "warning"
                ? "text-amber-600 dark:text-amber-400"
                : tone === "success"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "")
          }
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

/**
 * The partner's health screen. Utilisation and realisation are ratios of what
 * the firm recorded — when nothing was recorded they read "Not recorded", never
 * a flattering 0%.
 */
export function PartnerDashboardPanel() {
  const [data, setData] = useState<PartnerDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<PartnerDashboard>("/api/organization/partner"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const autoAssign = useCallback(async () => {
    setAssigning(true);
    setError(null);
    try {
      const result = await api<{
        assignment: { assigned: number; skipped: number; byUser: { name: string; assigned: number }[] };
      }>("/api/organization/partner/auto-assign", {
        method: "POST",
        body: JSON.stringify({ limit: 25 }),
      });
      const { assigned, skipped, byUser } = result.assignment;
      setNotice(
        assigned === 0
          ? skipped > 0
            ? `No run could be assigned (${skipped} skipped).`
            : "No unassigned run is waiting."
          : `Assigned ${assigned} run(s) by workload: ${byUser.map((row) => `${row.name} ${row.assigned}`).join(", ")}.`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAssigning(false);
    }
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading partner dashboard…
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="h-4 w-4" /> Partner dashboard
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={() => void autoAssign()} disabled={assigning}>
            {assigning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            Auto-assign unowned runs
          </Button>
        </div>
      </div>

      {notice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Utilisation"
              value={pct(data.totals.utilisationPct)}
              hint={`${(data.totals.billableMinutes / 60).toFixed(1)} billable of ${(data.totals.recordedMinutes / 60).toFixed(1)} recorded hours`}
            />
            <Metric
              label="Realisation"
              value={pct(data.totals.realisationPct)}
              hint={`${money(data.totals.collectedMinor)} collected of ${money(data.totals.collectedMinor + data.totals.outstandingMinor)} invoiced`}
              tone={data.totals.realisationPct !== null && data.totals.realisationPct < 50 ? "warning" : "success"}
            />
            <Metric
              label="Deadline risk"
              value={String(data.totals.overdueRuns)}
              hint={`${data.totals.due7} due in 7 days · ${data.totals.due30} in 30`}
              tone={data.totals.overdueRuns > 0 ? "critical" : data.totals.due7 > 0 ? "warning" : "success"}
            />
            <Metric
              label="Receivables"
              value={money(data.totals.outstandingMinor)}
              hint={`${money(data.totals.wipMinor)} unbilled WIP`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Due within 7 days
              </h3>
              {data.risk.length === 0 ? (
                <Card>
                  <CardContent className="p-4 text-sm text-muted-foreground">
                    Nothing is due in the next week and nothing is late.
                  </CardContent>
                </Card>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Client / run</th>
                        <th className="px-3 py-2">Due</th>
                        <th className="px-3 py-2">Owner</th>
                        <th className="px-3 py-2">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.risk.slice(0, 12).map((row) => (
                        <tr key={row.runId} className="border-t">
                          <td className="px-3 py-2">
                            <p className="font-medium">{row.title}</p>
                            <p className="text-xs text-muted-foreground">{row.engagementName}</p>
                          </td>
                          <td className={row.daysLate > 0 ? "px-3 py-2 text-destructive" : "px-3 py-2"}>
                            {fmtDate(row.dueDate)}
                            {row.daysLate > 0 ? ` · ${row.daysLate}d late` : ""}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{row.assigneeName ?? "Unassigned"}</td>
                          <td className="px-3 py-2">
                            <Badge
                              variant={
                                row.verificationStatus === "defective"
                                  ? "critical"
                                  : row.daysLate > 0
                                    ? "warning"
                                    : "outline"
                              }
                            >
                              {row.verificationStatus === "defective" ? "Defective" : row.stage}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Users className="h-3.5 w-3.5" /> Workload
              </h3>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[380px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Member</th>
                      <th className="px-3 py-2">Open runs</th>
                      <th className="px-3 py-2">Late</th>
                      <th className="px-3 py-2">Hours (7d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workload.map((member) => (
                      <tr key={member.userId} className="border-t">
                        <td className="px-3 py-2">
                          <p className="font-medium">{member.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {member.practiceRole ?? member.role}
                          </p>
                        </td>
                        <td className="px-3 py-2">{member.openRuns}</td>
                        <td
                          className={
                            member.overdueRuns > 0
                              ? "px-3 py-2 font-semibold text-destructive"
                              : "px-3 py-2"
                          }
                        >
                          {member.overdueRuns}
                        </td>
                        <td className="px-3 py-2">{(member.minutesThisWeek / 60).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Utilisation is billable share of recorded time — not attendance. Audit-only members are never
                auto-assigned.
              </p>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
