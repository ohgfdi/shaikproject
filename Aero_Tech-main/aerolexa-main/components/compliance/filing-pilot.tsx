"use client";

import { useEffect, useState } from "react";

import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { FilingPilotLedger, PilotVerdict } from "@/lib/server/filing-pilot";

const VERDICT_VARIANT: Record<PilotVerdict, "success" | "warning" | "default"> = {
  certified: "success",
  pilot: "warning",
  simulation: "default",
};

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString("en-IN") : "—";
}

export function FilingPilotView() {
  const [ledger, setLedger] = useState<FilingPilotLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<FilingPilotLedger>("/api/organization/compliance/filing-pilot");
        if (!cancelled) setLedger(data);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-danger">
          {error} Refresh the page to try again.
        </CardContent>
      </Card>
    );
  }
  if (!ledger) {
    return <p className="text-sm text-muted">Reading the filing evidence…</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={VERDICT_VARIANT[ledger.verdict]}>{ledger.verdict}</Badge>
            <span className="text-sm text-foreground">
              Gateway <code>{ledger.provider}</code> · active channel{" "}
              <code>{ledger.activeChannel}</code>
            </span>
          </div>
          <p className="text-sm text-muted">{ledger.summary}</p>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-caption uppercase text-muted">Live submissions</dt>
              <dd className="text-lg font-semibold text-foreground">{ledger.totals.liveSubmissions}</dd>
            </div>
            <div>
              <dt className="text-caption uppercase text-muted">Reconciled</dt>
              <dd className="text-lg font-semibold text-foreground">{ledger.totals.verifiedFilings}</dd>
            </div>
            <div>
              <dt className="text-caption uppercase text-muted">Simulated</dt>
              <dd className="text-lg font-semibold text-foreground">{ledger.totals.simulatedSubmissions}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-foreground">Channels</h3>
          <ul className="space-y-2">
            {ledger.channels.map((channel) => (
              <li key={channel.channel} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block text-foreground">
                    {channel.channel} {channel.active && <Badge variant="default">active</Badge>}
                  </span>
                  <span className="block text-caption text-muted">
                    {channel.configured
                      ? "Credentials complete"
                      : `Missing: ${channel.missing.join(", ") || "unknown"}`}
                  </span>
                </span>
                <Badge variant={channel.configured ? "success" : "warning"}>
                  {channel.configured ? "configured" : "incomplete"}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {ledger.nextActions.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <h3 className="text-sm font-semibold text-foreground">Next actions</h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              {ledger.nextActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2 p-4">
          <h3 className="text-sm font-semibold text-foreground">Recent filing attempts</h3>
          {ledger.recent.length === 0 ? (
            <p className="text-sm text-muted">No filing run has recorded a filed date yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="text-caption uppercase text-muted">
                  <tr>
                    <th className="py-1 pr-3">Filing</th>
                    <th className="py-1 pr-3">Client</th>
                    <th className="py-1 pr-3">Provider</th>
                    <th className="py-1 pr-3">Reference</th>
                    <th className="py-1 pr-3">Reconciliation</th>
                    <th className="py-1">Filed</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.recent.map((run) => (
                    <tr key={run.id} className="border-t border-line">
                      <td className="py-2 pr-3 text-foreground">{run.title}</td>
                      <td className="py-2 pr-3 text-muted">{run.clientName}</td>
                      <td className="py-2 pr-3 text-muted">{run.provider ?? "—"}</td>
                      <td className="py-2 pr-3 text-muted">{run.acknowledgementReference ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={run.verificationStatus === "verified" ? "success" : "warning"}>
                          {run.verificationStatus}
                        </Badge>
                      </td>
                      <td className="py-2 text-muted">{when(run.filedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
