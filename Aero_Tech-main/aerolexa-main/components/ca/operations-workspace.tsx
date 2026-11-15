"use client";

import { AlertTriangle, Clock3, FileSearch, Loader2, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PartnerDashboardPanel } from "@/components/ca/partner-dashboard-panel";
import { PracticeEconomicsPanel } from "@/components/ca/practice-economics-panel";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { FirmOperations } from "@/lib/server/operations";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint: string; tone?: "critical" | "warning" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={
            "mt-1 text-2xl font-semibold " +
            (tone === "critical" && value > 0
              ? "text-destructive"
              : tone === "warning" && value > 0
                ? "text-amber-600 dark:text-amber-400"
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

export function OperationsWorkspace() {
  const [data, setData] = useState<FirmOperations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chasing, setChasing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<FirmOperations>("/api/organization/operations"));
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

  const chase = useCallback(async () => {
    setChasing(true);
    setError(null);
    try {
      const result = await api<{ attempted: number; delivered: number; failed: number }>(
        "/api/organization/document-requests/remind",
        { method: "POST", body: JSON.stringify({ dueWithinDays: 0 }) },
      );
      setNotice(
        result.attempted === 0
          ? "No overdue document requests to chase."
          : `Recorded ${result.attempted} reminder(s); ${result.delivered} email(s) delivered, ${result.failed} without delivery.`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChasing(false);
    }
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading firm operations…
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
            <Stat
              label="Overdue obligations"
              value={data.totals.overdueObligations}
              hint={`${data.totals.dueSoonObligations} due within 30 days`}
              tone="critical"
            />
            <Stat
              label="Overdue documents"
              value={data.totals.overdueDocumentRequests}
              hint={`${data.totals.openDocumentRequests} requests still open`}
              tone="warning"
            />
            <Stat
              label="Filing runs in flight"
              value={data.totals.filingRunsInProgress}
              hint={`${data.totals.filingRunsOverdue} past their due date`}
              tone="warning"
            />
            <Stat label="Clients on the calendar" value={data.totals.clients} hint="Active engagements" />
          </div>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="h-4 w-4 text-destructive" /> SLA breaches
              </h2>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
                </Button>
                <Button size="sm" onClick={() => void chase()} disabled={chasing}>
                  {chasing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileSearch className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Chase overdue documents
                </Button>
              </div>
            </div>

            {data.sla.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  Nothing is late. Every obligation and document request is inside its deadline.
                </CardContent>
              </Card>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Client</th>
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Days late</th>
                      <th className="px-3 py-2">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sla.slice(0, 50).map((item, index) => (
                      <tr key={`${item.kind}-${item.engagementId}-${item.title}-${index}`} className="border-t">
                        <td className="px-3 py-2">{item.engagementName}</td>
                        <td className="px-3 py-2 font-medium">{item.title}</td>
                        <td className="px-3 py-2">
                          <Badge variant={item.kind === "obligation" ? "critical" : "warning"}>
                            {item.kind === "obligation" ? "Statutory" : "Document"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">{fmtDate(item.dueDate)}</td>
                        <td className="px-3 py-2 font-semibold text-destructive">{item.daysLate}</td>
                        <td className="px-3 py-2 text-muted-foreground">{item.ownerName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Clock3 className="h-4 w-4" /> Aging
              </h2>
              <Card>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Age</th>
                        <th className="px-3 py-2">Obligations</th>
                        <th className="px-3 py-2">Documents</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.aging.map((bucket) => (
                        <tr key={bucket.bucket} className="border-t">
                          <td className="px-3 py-2">{bucket.bucket} days</td>
                          <td className="px-3 py-2">{bucket.obligations}</td>
                          <td className="px-3 py-2">{bucket.documents}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </section>

            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4" /> Workload
              </h2>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Member</th>
                      <th className="px-3 py-2">Open runs</th>
                      <th className="px-3 py-2">Late runs</th>
                      <th className="px-3 py-2">Doc chases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workload.map((member) => (
                      <tr key={member.userId} className="border-t">
                        <td className="px-3 py-2">
                          <p className="font-medium">{member.name}</p>
                          <p className="text-xs text-muted-foreground">{member.role}</p>
                        </td>
                        <td className="px-3 py-2">{member.openRuns}</td>
                        <td className={member.overdueRuns > 0 ? "px-3 py-2 font-semibold text-destructive" : "px-3 py-2"}>
                          {member.overdueRuns}
                        </td>
                        <td className="px-3 py-2">{member.openDocumentRequests}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <PartnerDashboardPanel />
          <PracticeEconomicsPanel />
        </>
      ) : null}
    </div>
  );
}
