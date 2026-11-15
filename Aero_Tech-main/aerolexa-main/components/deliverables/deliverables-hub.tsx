"use client";

import { ArrowRight, FileCheck2, RefreshCw, ScrollText, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, CardContent, type BadgeVariant } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { DeliverablesHubResult, HubDeliverable } from "@/lib/server/deliverables-hub";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  DRAFT: "default",
  IN_REVIEW: "warning",
  REVIEWED: "info",
  SIGNED_OFF: "accent",
  ISSUED: "success",
  SUPERSEDED: "outline",
  WITHDRAWN: "critical",
  ARCHIVED: "outline",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : "—";
}

interface RenderPart {
  heading: string;
  body: string;
  ref?: string | null;
}

interface RenderedDeliverable {
  versionId: string;
  formatLabel: string;
  revision: number;
  assembledBody: string;
  parts: RenderPart[];
  contentHash: string;
}

/**
 * The deliverables register with the review ladder in one place:
 * draft → in review → reviewed → signed off → issued (UDIN). The API enforces
 * roles; this screen only offers the next legal action.
 */
export function DeliverablesHub() {
  const [data, setData] = useState<DeliverablesHubResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [engagementId, setEngagementId] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [formatCode, setFormatCode] = useState("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issueTarget, setIssueTarget] = useState<HubDeliverable | null>(null);
  const [issueUdin, setIssueUdin] = useState("");
  const [issueSource, setIssueSource] = useState("icai-udin-portal");
  const [issueNoUdin, setIssueNoUdin] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    row: HubDeliverable;
    rendered: RenderedDeliverable | null;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (engagementId !== "ALL") params.set("engagementId", engagementId);
      if (status !== "ALL") params.set("status", status);
      if (formatCode !== "ALL") params.set("formatCode", formatCode);
      const result = await api<DeliverablesHubResult>(`/api/organization/deliverables?${params.toString()}`);
      setData(result);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [engagementId, status, formatCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (row: HubDeliverable, action: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
      setBusyId(row.id);
      setError(null);
      setNotice(null);
      try {
        const result = await api<{
          version?: { udin?: string | null; documentReference?: string | null };
          udin?: string | null;
          documentReference?: string | null;
        }>(`/api/organization/engagements/${row.engagementId}/deliverables`, {
          method: "POST",
          body: JSON.stringify({ action, versionId: row.id, ...extra }),
        });
        if (action === "issue") {
          const issuedUdin = result.version?.udin ?? result.udin ?? null;
          const reference = result.version?.documentReference ?? result.documentReference ?? null;
          setNotice(
            issuedUdin
              ? `Issued with ICAI UDIN ${issuedUdin}. The client copy is now in the portal.`
              : `Issued as an internal copy (ref ${reference ?? "—"}) without an ICAI UDIN. Do not send it to a client or regulator.`,
          );
        } else {
          setNotice(`${row.formatLabel} · rev ${row.revision}: ${action.replaceAll("-", " ")} recorded.`);
        }
        await load();
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const submitIssue = useCallback(async () => {
    if (!issueTarget) return;
    const udin = issueUdin.trim().toUpperCase();
    if (!udin && !issueNoUdin) {
      setIssueError("Enter the real ICAI UDIN, or tick the internal-copy acknowledgement.");
      return;
    }
    if (udin && !/^[A-Z0-9]{21}$/.test(udin)) {
      setIssueError("A UDIN is exactly 21 uppercase letters or digits.");
      return;
    }
    setIssueError(null);
    const issued = await act(issueTarget, "issue", udin ? { udin, udinSource: issueSource } : { noUdinAcknowledged: true });
    if (issued) setIssueTarget(null);
  }, [act, issueNoUdin, issueSource, issueTarget, issueUdin]);

  const openPreview = useCallback(async (row: HubDeliverable) => {
    setPreview({ row, rendered: null, loading: true, error: null });
    try {
      const rendered = await api<RenderedDeliverable>(
        `/api/organization/engagements/${row.engagementId}/deliverables/${row.id}/render?variant=CLIENT`,
      );
      setPreview({ row, rendered, loading: false, error: null });
    } catch (err) {
      setPreview({ row, rendered: null, loading: false, error: errorMessage(err) });
    }
  }, []);

  const formats = useMemo(() => data?.formats ?? [], [data]);

  const totals = data?.totals;
  const issuedPct =
    totals && totals.total > 0 ? Math.round((totals.issued / totals.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Draft" value={totals?.byStatus.DRAFT ?? 0} />
        <Stat label="In review" value={totals?.byStatus.IN_REVIEW ?? 0} tone="warning" />
        <Stat label="Reviewed" value={totals?.byStatus.REVIEWED ?? 0} />
        <Stat label="Signed off" value={totals?.byStatus.SIGNED_OFF ?? 0} tone="warning" />
        <Stat label="Issued" value={totals?.issued ?? 0} tone="success" />
        <Stat label="Outstanding" value={totals?.outstanding ?? 0} hint={`${issuedPct}% of the register issued`} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Client engagement" className="min-w-56 flex-1 sm:max-w-xs">
          <Select
            value={engagementId}
            onChange={(e) => setEngagementId(e.target.value)}
            options={[
              { value: "ALL", label: "All clients" },
              ...(data?.engagements ?? []).map((e) => ({
                value: e.id,
                label: `${e.name}${e.code ? ` · ${e.code}` : ""}`,
              })),
            ]}
          />
        </Field>
        <Field label="Status" className="w-40">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: "ALL", label: "All statuses" },
              { value: "DRAFT", label: "Draft" },
              { value: "IN_REVIEW", label: "In review" },
              { value: "REVIEWED", label: "Reviewed" },
              { value: "SIGNED_OFF", label: "Signed off" },
              { value: "ISSUED", label: "Issued" },
              { value: "SUPERSEDED", label: "Superseded" },
            ]}
          />
        </Field>
        <Field label="Format" className="w-48">
          <Select
            value={formatCode}
            onChange={(e) => setFormatCode(e.target.value)}
            options={[
              { value: "ALL", label: "All formats" },
              ...formats.map((f) => ({ value: f.code, label: f.label })),
            ]}
          />
        </Field>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          <RefreshCw aria-hidden className="size-4" /> Refresh
        </Button>
      </div>

      {notice && (
        <p className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">{notice}</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {data?.truncated && (
        <p className="text-caption text-muted">
          Showing the {data.deliverables.length} most recent deliverables; totals cover the full register.
        </p>
      )}

      {issueTarget && (
        <Card>
          <CardContent className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Issue {issueTarget.formatLabel} · rev {issueTarget.revision}
              </h2>
              <p className="mt-1 text-caption text-muted">
                Enter the UDIN ICAI issued for this document. The app does not mint UDINs and does not contact the ICAI
                registry. If you have not obtained one, issue an internal copy only — never send that copy to a client or
                regulator.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ICAI UDIN">
                <Input
                  value={issueUdin}
                  onChange={(e) => setIssueUdin(e.target.value.toUpperCase())}
                  maxLength={21}
                  placeholder="21 uppercase letters or digits"
                  autoComplete="off"
                />
              </Field>
              <Field label="Source">
                <Select
                  value={issueSource}
                  onChange={(e) => setIssueSource(e.target.value)}
                  options={[
                    { value: "icai-udin-portal", label: "ICAI UDIN portal" },
                    { value: "dsc-based-generation", label: "DSC-based generation" },
                    { value: "captured-manually", label: "Captured manually" },
                  ]}
                />
              </Field>
            </div>
            <Checkbox
              label="Issue as an internal copy without a UDIN (not for a client or regulator)"
              checked={issueNoUdin}
              onChange={setIssueNoUdin}
            />
            {issueError && <p className="text-sm text-danger">{issueError}</p>}
            <div className="flex items-center gap-2">
              <Button type="button" onClick={() => void submitIssue()} disabled={busyId === issueTarget.id}>
                {busyId === issueTarget.id ? "Issuing…" : "Issue deliverable"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setIssueTarget(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="px-4 py-8 text-sm text-muted">Loading the deliverable register…</p>
          ) : !data || data.deliverables.length === 0 ? (
            <div className="space-y-1 px-4 py-8">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <FileCheck2 aria-hidden className="size-4" /> No deliverables match this filter
              </p>
              <p className="text-caption text-muted">
                Assemble a deliverable from Settings → Governance, or clear the filters. Only issued client copies are
                published to the client portal.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[64rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-caption text-muted uppercase">
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Deliverable</th>
                    <th className="px-3 py-2 font-medium">Revision</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">UDIN / internal ref</th>
                    <th className="px-3 py-2 font-medium">Updated</th>
                    <th className="px-3 py-2 font-medium">Next step</th>
                    <th className="px-3 py-2 font-medium sr-only">View</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliverables.map((row) => (
                    <tr key={row.id} className="border-b border-line/70 align-top hover:bg-surface-2/40">
                      <td className="px-3 py-3">
                        <span className="block font-medium text-foreground">{row.engagementName}</span>
                        <span className="block text-caption text-muted">{row.engagementCode ?? "No code"}</span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="block text-foreground">{row.formatLabel}</span>
                        <span className="block text-caption text-muted">
                          {row.formatCode} · {row.variant}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-foreground tabular-nums">v{row.revision}</td>
                      <td className="px-3 py-3">
                        <Badge variant={STATUS_VARIANT[row.status] ?? "default"}>
                          {row.status.replaceAll("_", " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">
                        {row.udin ? (
                          <span className="flex items-center gap-1 font-mono text-caption text-foreground">
                            <ShieldCheck aria-hidden className="size-3.5 text-emerald" /> {row.udin}
                          </span>
                        ) : row.documentReference ? (
                          <span
                            className="font-mono text-caption text-muted"
                            title="Internal tracking reference — not an ICAI UDIN"
                          >
                            Ref {row.documentReference} · not a UDIN
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-muted">{fmtDate(row.updatedAt)}</td>
                      <td className="px-3 py-3">
                        <span className="flex flex-wrap gap-1">
                          {row.status === "DRAFT" && (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={busyId === row.id}
                              onClick={() => void act(row, "submit-for-review")}
                            >
                              Submit for review
                            </Button>
                          )}
                          {row.status === "IN_REVIEW" && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={busyId === row.id}
                                onClick={() => void act(row, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={busyId === row.id}
                                onClick={() => void act(row, "reject")}
                              >
                                Reject
                              </Button>
                            </>
                          )}
                          {(row.status === "REVIEWED" || row.status === "IN_REVIEW") && (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={busyId === row.id}
                              onClick={() => void act(row, "sign-off")}
                            >
                              Sign off
                            </Button>
                          )}
                          {row.status === "SIGNED_OFF" && (
                            <Button
                              type="button"
                              size="sm"
                              disabled={busyId === row.id}
                              onClick={() => {
                                setIssueTarget(row);
                                setIssueUdin("");
                                setIssueSource("icai-udin-portal");
                                setIssueNoUdin(false);
                                setIssueError(null);
                              }}
                            >
                              Issue <ArrowRight aria-hidden className="size-3.5" />
                            </Button>
                          )}
                          {row.status === "ISSUED" && (
                            <span className="text-caption text-muted">Published to portal</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Button type="button" size="sm" variant="ghost" onClick={() => void openPreview(row)}>
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ScrollText aria-hidden className="size-4" /> {preview.row.formatLabel} · rev {preview.row.revision}{" "}
                <Badge variant="outline">CLIENT copy</Badge>
              </h2>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Close
              </Button>
            </div>
            {preview.loading && <p className="text-sm text-muted">Rendering the client copy…</p>}
            {preview.error && <p className="text-sm text-danger">{preview.error}</p>}
            {preview.rendered && (
              <div className="space-y-3">
                <p className="text-caption text-muted">
                  Placeholders resolved, identifiers scrubbed and redactions applied. Content hash{" "}
                  <span className="font-mono">{preview.rendered.contentHash.slice(0, 16)}…</span>
                </p>
                {preview.rendered.parts.length === 0 ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">
                    {preview.rendered.assembledBody}
                  </pre>
                ) : (
                  preview.rendered.parts.map((part, index) => (
                    <section key={`${part.heading}-${index}`} className="space-y-1">
                      <h3 className="text-sm font-semibold text-foreground">{part.heading}</h3>
                      <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">{part.body}</pre>
                    </section>
                  ))
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-caption text-muted">
        The ladder is fixed: draft → in review → reviewed → signed off → issued. Issuing requires a signed-off version
        and a real ICAI UDIN, or an explicit internal-copy acknowledgement. The app never mints a UDIN, supersedes the
        prior issued revision and publishes the client copy to the portal. Roles are enforced by the API, not this
        screen.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "warning" | "success";
}) {
  const border =
    tone === "warning" ? "border-[#F08A5D]/40" : tone === "success" ? "border-[#58B368]/40" : "border-line";
  return (
    <Card className={border}>
      <CardContent className="space-y-1">
        <p className="text-caption text-muted uppercase">{label}</p>
        <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
        {hint && <p className="text-caption text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}
