"use client";

import {
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Link2,
  FileWarning,
  Lock,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EngagementAccessPanel } from "@/components/ca/engagement-access-panel";
import { PortalAccountsPanel } from "@/components/practice/portal-accounts-panel";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, CardContent, type BadgeVariant } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { DOCUMENT_CATEGORIES } from "@/lib/engine/ca-documents";
import type { PortalLinkView, PortalUploadView } from "@/lib/server/client-portal";
import type {
  EngagementFlag,
  EngagementHealth,
  EngagementOverviewDetail,
  PracticeOverview,
} from "@/lib/server/practice-overview";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  ACTIVE: "success",
  PAUSED: "warning",
  ARCHIVED: "default",
};

const FLAG_LABEL: Record<EngagementFlag, { label: string; variant: BadgeVariant }> = {
  "review-backlog": { label: "Review backlog", variant: "warning" },
  "draft-backlog": { label: "Draft pile", variant: "info" },
  "open-changes": { label: "Open changes", variant: "accent" },
  "no-team": { label: "No team", variant: "critical" },
  stale: { label: "Stale 30d", variant: "outline" },
  "legal-hold": { label: "Legal hold", variant: "critical" },
};

const ROLE_LABEL: Record<string, string> = {
  PARTNER: "Partner",
  MANAGER: "Manager",
  REVIEWER: "Reviewer",
  SENIOR: "Senior",
  ASSISTANT: "Assistant",
  AUDITOR: "Auditor (read-only)",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : "—";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The engagement workspace: a partner dashboard over the firm's client list.
 *
 * Reads only `/api/organization/practice` (cross-client counts) and, on expand,
 * `/api/organization/engagements/:id/overview` (one client's team/review
 * queue). Writes use the existing engagement API, so access control stays in
 * the server layer.
 */
export function EngagementsWorkspace() {
  const [overview, setOverview] = useState<PracticeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    id: string;
    data: EngagementOverviewDetail | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", gstin: "", description: "" });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ overview: PracticeOverview }>("/api/organization/practice");
      setOverview(data.overview);
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

  const openDetail = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      setDetail({ id, data: null, loading: true, error: null });
      try {
        const data = await api<{ overview: EngagementOverviewDetail }>(
          `/api/organization/engagements/${id}/overview`,
        );
        setDetail({ id, data: data.overview, loading: false, error: null });
      } catch (err) {
        setDetail({ id, data: null, loading: false, error: errorMessage(err) });
      }
    },
    [expandedId],
  );

  const create = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!form.name.trim()) return;
      setCreating(true);
      setError(null);
      try {
        await api("/api/organization/engagements", {
          method: "POST",
          body: JSON.stringify({
            name: form.name,
            code: form.code || undefined,
            gstin: form.gstin || undefined,
            description: form.description || undefined,
          }),
        });
        setForm({ name: "", code: "", gstin: "", description: "" });
        setShowCreate(false);
        setNote("Client engagement created.");
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setCreating(false);
      }
    },
    [form, load],
  );

  const setEngagementStatus = useCallback(
    async (row: EngagementHealth, next: "ACTIVE" | "PAUSED") => {
      setBusyId(row.id);
      setError(null);
      try {
        await api(`/api/organization/engagements/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: next }),
        });
        setNote(`${row.name} ${next === "PAUSED" ? "paused" : "resumed"}.`);
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const rows = useMemo(() => {
    const all = overview?.engagements ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((row) => {
      if (status !== "ALL" && row.status !== status) return false;
      if (attentionOnly && row.flags.length === 0) return false;
      if (!q) return true;
      return `${row.name} ${row.code ?? ""} ${row.jurisdiction}`.toLowerCase().includes(q);
    });
  }, [overview, query, status, attentionOnly]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <RefreshCw aria-hidden className="size-4 animate-spin" />
        Loading the firm&apos;s engagements…
      </div>
    );
  }

  if (!overview) {
    return (
      <Card>
        <CardContent className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Building2 aria-hidden className="size-4" />
            The practice dashboard needs a firm account
          </p>
          <p className="text-caption text-muted">
            {error ?? "Create an organization first; engagements are client silos under the firm."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const totals = overview.totals;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Clients" value={totals.clients} hint={`${totals.active} active · ${totals.paused} paused`} />
        <Stat
          label="Awaiting review"
          value={totals.papersAwaitingReview}
          hint="working papers in review"
          tone={totals.papersAwaitingReview > 0 ? "warning" : undefined}
        />
        <Stat label="Drafts" value={totals.papersDraft} hint="papers not yet reviewed" />
        <Stat
          label="Open changes"
          value={totals.openChanges}
          hint="change requests in flight"
          tone={totals.openChanges > 0 ? "warning" : undefined}
        />
        <Stat
          label="Deliverables"
          value={totals.deliverablesAwaitingReview}
          hint={`${totals.deliverablesSigned} signed off`}
        />
        <Stat
          label="Needs attention"
          value={totals.needsAttention}
          hint={`${totals.engagementsWithoutTeam} unstaffed · ${totals.staleEngagements} stale`}
          tone={totals.needsAttention > 0 ? "critical" : undefined}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
          <Input
            className="pl-8"
            placeholder="Search client, code or jurisdiction"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search engagements"
          />
        </div>
        <Select
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "ALL", label: "All statuses" },
            { value: "ACTIVE", label: "Active" },
            { value: "PAUSED", label: "Paused" },
            { value: "ARCHIVED", label: "Archived" },
          ]}
          aria-label="Filter by status"
        />
        <Button
          type="button"
          variant={attentionOnly ? "primary" : "secondary"}
          onClick={() => setAttentionOnly((v) => !v)}
        >
          <FileWarning aria-hidden className="size-4" />
          Needs attention
        </Button>
        <Button type="button" variant="secondary" onClick={() => setShowCreate((v) => !v)}>
          <Plus aria-hidden className="size-4" />
          New engagement
        </Button>
      </div>

      {note && (
        <p className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">{note}</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      {showCreate && (
        <Card>
          <CardContent>
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={create}>
              <Field label="Client / engagement name" required>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Sharma Textiles Pvt Ltd — FY 2025-26 audit"
                  required
                />
              </Field>
              <Field label="Client code" helper="Short code used across the file, e.g. SHARMA-FY26.">
                <Input
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                  placeholder="SHARMA-FY26"
                />
              </Field>
              <Field label="GSTIN" helper="Optional; used to scope GST work to this client.">
                <Input
                  value={form.gstin}
                  onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                  placeholder="27AAAAA0000A1Z5"
                />
              </Field>
              <Field label="Scope note" className="sm:col-span-2">
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Statutory audit, tax audit u/s 44AB and ROC filings."
                  rows={2}
                />
              </Field>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Button type="submit" disabled={creating || !form.name.trim()}>
                  {creating ? "Creating…" : "Create engagement"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <span className="text-caption text-muted">A project is created automatically to hold the file.</span>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-caption text-muted uppercase">
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Team</th>
                  <th className="px-3 py-2 font-medium">Papers</th>
                  <th className="px-3 py-2 font-medium">Deliverables</th>
                  <th className="px-3 py-2 font-medium">Changes</th>
                  <th className="px-3 py-2 font-medium">Last activity</th>
                  <th className="px-3 py-2 font-medium">Flags</th>
                  <th className="px-3 py-2 font-medium sr-only">Open</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-muted">
                      No engagements match this filter.
                    </td>
                  </tr>
                )}
                {rows.map((row) => {
                  const open = expandedId === row.id;
                  return (
                    <EngagementRows
                      key={row.id}
                      row={row}
                      open={open}
                      detail={detail?.id === row.id ? detail : null}
                      busy={busyId === row.id}
                      onToggle={() => void openDetail(row.id)}
                      onStatus={setEngagementStatus}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-caption text-muted">
        Review backlog = working papers waiting on a reviewer. A client is stale after 30 days without activity.
        Legal holds freeze retention and erasure regardless of the retention window.
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
  hint: string;
  tone?: "warning" | "critical";
}) {
  const border = tone === "critical" ? "border-[#E8637A]/40" : tone === "warning" ? "border-[#F08A5D]/40" : "border-line";
  return (
    <Card className={border}>
      <CardContent className="space-y-1">
        <p className="text-caption text-muted uppercase">{label}</p>
        <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
        <p className="text-caption text-muted">{hint}</p>
      </CardContent>
    </Card>
  );
}

function EngagementRows({
  row,
  open,
  detail,
  busy,
  onToggle,
  onStatus,
}: {
  row: EngagementHealth;
  open: boolean;
  detail: { id: string; data: EngagementOverviewDetail | null; loading: boolean; error: string | null } | null;
  busy: boolean;
  onToggle: () => void;
  onStatus: (row: EngagementHealth, next: "ACTIVE" | "PAUSED") => Promise<void>;
}) {
  return (
    <>
      <tr className="border-b border-line/70 align-top hover:bg-surface-2/40">
        <td className="px-3 py-3">
          <button type="button" className="flex items-start gap-2 text-left" onClick={onToggle}>
            {open ? (
              <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            ) : (
              <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            )}
            <span>
              <span className="block font-medium text-foreground">{row.name}</span>
              <span className="block text-caption text-muted">
                {row.code ?? "No code"} · {row.jurisdiction} · {row.dataClassification}
              </span>
            </span>
          </button>
        </td>
        <td className="px-3 py-3">
          <Badge variant={STATUS_VARIANT[row.status] ?? "default"}>{row.status}</Badge>
        </td>
        <td className="px-3 py-3 text-foreground">
          <span className="flex items-center gap-1">
            <Users aria-hidden className="size-3.5 text-muted" />
            {row.teamSize === 0 ? <span className="text-danger">Unstaffed</span> : row.teamSize}
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="text-foreground tabular-nums">{row.papers.total}</span>
          <span className="block text-caption text-muted">
            {row.papers.draft} draft · {row.papers.inReview} review · {row.papers.signedOff} signed
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="text-foreground tabular-nums">{row.deliverablesTotal}</span>
          <span className="block text-caption text-muted">
            {row.deliverablesAwaitingReview} in review · {row.deliverablesSigned} signed
          </span>
        </td>
        <td className="px-3 py-3">
          {row.openChanges > 0 ? (
            <Badge variant="warning">{plural(row.openChanges, "open")}</Badge>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="px-3 py-3 text-muted">
          <span className="flex items-center gap-1">
            <Clock3 aria-hidden className="size-3.5" />
            {fmtDate(row.lastActivityAt)}
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="flex flex-wrap gap-1">
            {row.flags.length === 0 ? (
              <span className="text-caption text-muted">Clear</span>
            ) : (
              row.flags.map((flag) => (
                <Badge key={flag} variant={FLAG_LABEL[flag].variant}>
                  {FLAG_LABEL[flag].label}
                </Badge>
              ))
            )}
          </span>
        </td>
        <td className="px-3 py-3 text-right">
          {row.status !== "ARCHIVED" && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onStatus(row, row.status === "PAUSED" ? "ACTIVE" : "PAUSED")}
            >
              {row.status === "PAUSED" ? "Resume" : "Pause"}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-surface-2/30">
          <td colSpan={9} className="px-4 py-4">
            {detail?.loading && <p className="text-sm text-muted">Loading client details…</p>}
            {detail?.error && <p className="text-sm text-danger">{detail.error}</p>}
            {detail?.data && (
                <>
                  <EngagementDetail data={detail.data} />
                  <EngagementAccessPanel engagementId={row.id} engagementName={row.name} />
                </>
              )}
          </td>
        </tr>
      )}
    </>
  );
}

function EngagementDetail({ data }: { data: EngagementOverviewDetail }) {
  const reviewQueue = data.papers.filter((p) => p.status === "IN_REVIEW");
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users aria-hidden className="size-4" /> Team ({data.team.length})
        </h3>
        {data.team.length === 0 ? (
          <p className="text-caption text-muted">
            Nobody is assigned yet. Firm roles still grant access, but assign a partner and manager so review
            responsibility is explicit.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.team.map((member) => (
              <li key={member.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-foreground">{member.name}</span>
                <Badge variant={member.practiceRole === "PARTNER" ? "accent" : "default"}>
                  {ROLE_LABEL[member.practiceRole] ?? member.practiceRole}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-caption text-muted">
          {data.retentionReason} · {data.engagement.dataClassification}
        </p>
        {data.engagement.legalHold && (
          <p className="flex items-center gap-1 text-caption text-danger">
            <ShieldAlert aria-hidden className="size-3.5" /> Legal hold — erasure and purge are frozen.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ClipboardCheck aria-hidden className="size-4" /> Review queue ({reviewQueue.length})
        </h3>
        {reviewQueue.length === 0 ? (
          <p className="text-caption text-muted">
            No working paper is waiting for review. {data.paperCounts.draft} draft
            {data.paperCounts.draft === 1 ? "" : "s"} still to prepare.
          </p>
        ) : (
          <ul className="space-y-1">
            {reviewQueue.slice(0, 6).map((paper) => (
              <li key={paper.id} className="flex items-start justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-foreground">
                    {paper.indexRef} · {paper.title}
                  </span>
                  <span className="block text-caption text-muted">
                    {paper.saReference ?? "SA 230"} · updated {fmtDate(paper.updatedAt)}
                  </span>
                </span>
                <Badge variant="warning">Review</Badge>
              </li>
            ))}
          </ul>
        )}
        {(data.changeRequests.length > 0 && (
          <div className="space-y-1">
            <p className="text-caption font-medium text-muted uppercase">Open changes</p>
            <ul className="space-y-1">
              {data.changeRequests.slice(0, 4).map((change) => (
                <li key={change.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-foreground">{change.title}</span>
                  <Badge variant="warning">{change.state.replaceAll("_", " ")}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )) || null}
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileWarning aria-hidden className="size-4" /> Deliverables ({data.deliverables.total})
        </h3>
        {data.deliverables.recent.length === 0 ? (
          <p className="text-caption text-muted">No signed or assembled deliverables yet.</p>
        ) : (
          <ul className="space-y-1">
            {data.deliverables.recent.slice(0, 4).map((deliverable) => (
              <li key={deliverable.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-foreground">{deliverable.label}</span>
                <Badge variant={deliverable.status === "IN_REVIEW" ? "warning" : "default"}>
                  {deliverable.status.replaceAll("_", " ")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Link
            href="/working-papers"
            className="inline-flex items-center gap-1 text-caption font-medium text-accent-strong hover:underline"
          >
            Working papers <ArrowUpRight aria-hidden className="size-3" />
          </Link>
          <Link
            href="/document-requests"
            className="inline-flex items-center gap-1 text-caption font-medium text-accent-strong hover:underline"
          >
            Document requests <ArrowUpRight aria-hidden className="size-3" />
          </Link>
          <Link
            href="/books"
            className="inline-flex items-center gap-1 text-caption font-medium text-accent-strong hover:underline"
          >
            Books <ArrowUpRight aria-hidden className="size-3" />
          </Link>
        </div>
      </div>
      <div className="lg:col-span-3">
        <PortalPanel engagementId={data.engagement.id} />
        <PortalAccountsPanel engagementId={data.engagement.id} />
      </div>
    </div>
  );
}

/**
 * Firm-side client portal controls, loaded only when a client row is expanded.
 * The raw link is shown exactly once — the API never returns it again, because
 * only its hash is stored.
 */
interface PortalRequestRow {
  id: string;
  title: string;
  category: string;
  period: string | null;
  dueDate: string;
  status: string;
  fulfilledByUploadId: string | null;
}

function PortalPanel({ engagementId }: { engagementId: string }) {
  const [links, setLinks] = useState<PortalLinkView[]>([]);
  const [uploads, setUploads] = useState<PortalUploadView[]>([]);
  const [requests, setRequests] = useState<PortalRequestRow[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestTitle, setRequestTitle] = useState("");
  const [requestCategory, setRequestCategory] = useState("other");
  const [requestDue, setRequestDue] = useState("");
  const [creatingRequest, setCreatingRequest] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{
        links: PortalLinkView[];
        uploads: PortalUploadView[];
        requests: PortalRequestRow[];
      }>(`/api/organization/engagements/${engagementId}/portal`);
      setLinks(data.links ?? []);
      setUploads(data.uploads ?? []);
      setRequests(data.requests ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
    setOrigin(window.location.origin);
  }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ link: PortalLinkView & { raw: string } }>(
        `/api/organization/engagements/${engagementId}/portal`,
        { method: "POST", body: JSON.stringify({ expiresInDays: 30 }) },
      );
      setRaw(data.link.raw);
      setCopied(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [engagementId, load]);

  const revoke = useCallback(
    async (tokenId: string) => {
      setBusy(true);
      setError(null);
      try {
        await api(`/api/organization/engagements/${engagementId}/portal/${tokenId}`, { method: "DELETE" });
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [engagementId, load],
  );

  const copy = useCallback(async () => {
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(`${origin}/portal/${raw}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [origin, raw]);

  const createRequest = useCallback(async () => {
    if (!requestTitle.trim() || !requestDue) return;
    setCreatingRequest(true);
    setError(null);
    try {
      await api(`/api/organization/engagements/${engagementId}/document-requests`, {
        method: "POST",
        body: JSON.stringify({
          title: requestTitle.trim(),
          category: requestCategory,
          dueDate: requestDue,
        }),
      });
      setRequestTitle("");
      setRequestDue("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreatingRequest(false);
    }
  }, [engagementId, requestTitle, requestCategory, requestDue, load]);

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock aria-hidden className="size-4" /> Client portal
        </h3>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void create()}>
          <Link2 aria-hidden className="size-4" /> Create client link
        </Button>
      </div>
      <p className="text-caption text-muted">
        A client link shows only issued client-variant deliverables and lets the client upload documents. It expires
        after 30 days, can be revoked at any time, and stores only a hash of the token. Creating or revoking a link
        needs a partner or manager.
      </p>

      {raw && (
        <div className="space-y-1 rounded-md border border-amber/40 bg-amber/10 px-3 py-2">
          <p className="text-caption font-medium text-foreground">
            Copy this link now — it is shown once and cannot be recovered.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input readOnly value={origin ? `${origin}/portal/${raw}` : raw} />
            <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-caption text-danger">{error}</p>}

      {links.length === 0 ? (
        <p className="text-caption text-muted">No portal link has been created for this client.</p>
      ) : (
        <ul className="space-y-1">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-foreground">
                  {link.label ?? `Link ${link.prefix}…`}
                </span>
                <span className="block text-caption text-muted">
                  {link.state === "active" ? `Expires ${fmtDate(link.expiresAt)}` : `${link.state} · ${fmtDate(link.revokedAt ?? link.expiresAt)}`}
                  {link.lastUsedAt ? ` · last used ${fmtDate(link.lastUsedAt)}` : " · never used"}
                </span>
              </span>
              {link.state === "active" ? (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(link.id)}>
                  Revoke
                </Button>
              ) : (
                <Badge variant={link.state === "expired" ? "warning" : "default"}>{link.state}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-caption font-medium text-muted uppercase">
          Document requests ({requests.filter((r) => r.status === "requested").length} open)
        </p>
        <p className="text-caption text-muted">
          Open requests appear in the client&apos;s portal. When they upload a document in answer to one, it is marked
          received automatically.
        </p>
        {requests.length > 0 && (
          <ul className="space-y-1">
            {requests.slice(0, 6).map((request) => (
              <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-foreground">{request.title}</span>
                  <span className="block text-caption text-muted">
                    {request.category} · due {fmtDate(request.dueDate)}
                  </span>
                </span>
                <Badge variant={request.status === "requested" ? "warning" : "success"}>
                  {request.status === "requested" ? "open" : "received"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem_9rem_auto]">
          <Field label="New request">
            <Input
              value={requestTitle}
              onChange={(e) => setRequestTitle(e.target.value)}
              placeholder="Bank statement — Apr to Sep"
            />
          </Field>
          <Field label="Category">
            <Select
              value={requestCategory}
              onChange={(e) => setRequestCategory(e.target.value)}
              options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: c.replaceAll("-", " ") }))}
            />
          </Field>
          <Field label="Due">
            <Input type="date" value={requestDue} onChange={(e) => setRequestDue(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={creatingRequest || !requestTitle.trim() || !requestDue}
              onClick={() => void createRequest()}
            >
              <Plus aria-hidden className="size-4" /> Request
            </Button>
          </div>
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2">
          <p className="text-caption font-medium text-muted uppercase">Client uploads ({uploads.length})</p>
          <ul className="space-y-1">
            {uploads.slice(0, 5).map((upload) => (
              <li key={upload.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <a
                    href={`/api/organization/engagements/${engagementId}/portal/uploads/${upload.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-foreground hover:underline"
                  >
                    {upload.filename}
                  </a>
                  <span className="block text-caption text-muted">
                    {Math.max(1, Math.round(upload.sizeBytes / 1024))} KB · sha256 {upload.sha256.slice(0, 12)}…
                  </span>
                </span>
                <span className="text-caption text-muted">{fmtDate(upload.uploadedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
