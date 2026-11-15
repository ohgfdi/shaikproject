"use client";

/**
 * Statute & rate registry panel.
 *
 * The gap this closes: the app could compute against whatever rate table it was
 * given, but nothing in it recorded WHICH rules were in force, since when, and
 * on what authority. Every number a firm files has to be reproducible years
 * later — so this desk shows, for a chosen as-on date:
 *
 *   - the catalogue slot (slab / rate / threshold / window a firm must keep current),
 *   - the version in force then, with its citation and effective window,
 *   - the notifications the authority feeds delivered, waiting for review,
 *   - and a one-click path from a notification to a DRAFT version that carries
 *     the current value forward so the reviewer edits the single number that
 *     changed — never re-typing the table.
 *
 * Publishing CLOSES the window it replaces rather than deleting history, so an
 * as-on lookup for a past engagement still resolves what was genuinely in force.
 */

import { AlertTriangle, BookOpenCheck, Download, Plus, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface RuleVersionView {
  id: string;
  ruleKey: string;
  version: number;
  unit: string;
  rows: { upTo: number | null; rate: number; label?: string }[];
  valueSummary: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "published" | "superseded";
  supersedes: string | null;
  applicability: { ay: string | null; entityTypes: string[]; states: string[]; scope: "central" | "state" };
}

interface CatalogueEntry {
  key: string;
  label: string;
  unit: string;
  authority: string;
  description: string;
  cadence: "annual" | "quarterly" | "ad-hoc";
  inForce: RuleVersionView | null;
  latest: RuleVersionView | null;
  versions: number;
  unresolved: boolean;
}

interface NotificationView {
  id: string;
  title: string;
  authority: string;
  kind: string;
  externalId: string | null;
  url: string;
  publishedAt: string | null;
  effectiveFrom: string | null;
  excerpt: string;
  impactedRuleKeys: string[];
  warnings: string[];
  status: string;
  fetchedAt: string;
}

interface SourceView {
  id: string;
  key: string;
  name: string;
  authority: string;
  url: string;
  format: string;
  active: boolean;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

interface RegistryOverview {
  asOn: string;
  context: { ay: string | null; entityType: string | null; state: string | null };
  entries: CatalogueEntry[];
  notifications: NotificationView[];
  sources: SourceView[];
  summary: {
    rulesTracked: number;
    rulesInForce: number;
    rulesUnresolved: number;
    notificationsNew: number;
    sourcesActive: number;
  };
}

interface DraftView {
  ruleKey: string;
  label: string;
  unit: string;
  applicability: { ay: string | null; entityTypes: string[]; states: string[]; scope: "central" | "state" };
  rows: { upTo: number | null; rate: number; label?: string }[];
  valueSummary: string;
  citation: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notificationId: string;
  warnings: string[];
}

const AUTHORITIES = ["cbdt", "cbic", "mca", "rbi", "epfo", "gst-council", "state", "other"] as const;
const AYS = ["", "2024-25", "2025-26", "2026-27", "2027-28"];
const STATES = [
  "",
  "MH",
  "KA",
  "TN",
  "GJ",
  "UP",
  "WB",
  "TS",
  "AP",
  "KL",
  "RJ",
  "MP",
  "HR",
  "PB",
  "BR",
  "OR",
  "AS",
  "JH",
];

const today = () => new Date().toISOString().slice(0, 10);

function statusBadge(status: string) {
  if (status === "applied") return <Badge variant="success">Applied</Badge>;
  if (status === "ignored") return <Badge variant="outline">Ignored</Badge>;
  return <Badge variant="warning">Needs review</Badge>;
}

/** Human summary of a rate table: "≤ ₹4,00,000: 0% · ≤ ₹8,00,000: 5% …". */
function rowsSummary(rows: { upTo: number | null; rate: number }[], unit: string): string {
  return rows
    .map((r) => {
      const bound = r.upTo === null ? "above" : `≤ ${r.upTo}`;
      const value =
        unit === "bps"
          ? `${r.rate / 100}%`
          : unit === "days"
            ? `${r.rate} days`
            : unit === "months"
              ? `${r.rate} months`
              : `${r.rate}`;
      return `${bound}: ${value}`;
    })
    .join(" · ");
}

export function StatutesPanel() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<RegistryOverview | null>(null);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [asOn, setAsOn] = useState(today());
  const [ay, setAy] = useState("2025-26");
  const [state, setState] = useState("");

  const [newSource, setNewSource] = useState({ key: "", name: "", authority: "cbdt", url: "" });
  const [drafts, setDrafts] = useState<Array<DraftView & { rowsText: string }>>([]);
  const [draftFrom, setDraftFrom] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy((b) => b ?? "load");
    setError(null);
    try {
      const sp = new URLSearchParams({ asOn });
      if (ay) sp.set("ay", ay);
      if (state) sp.set("state", state);
      const res = await api<{ registry: RegistryOverview; canAuthor: boolean }>(`/api/statutes?${sp.toString()}`);
      setOverview(res.registry);
      setCanAuthor(res.canAuthor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
      setBusy((b) => (b === "load" ? null : b));
    }
  }, [asOn, ay, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const seed = async () => {
    setBusy("seed");
    try {
      const res = await api<{ result: { published: number; skipped: number } }>("/api/statutes/seed", {
        method: "POST",
      });
      toast({
        title: "Registry seeded",
        message:
          res.result.published > 0
            ? `${res.result.published} built-in version(s) published; ${res.result.skipped} already present.`
            : "Every built-in default was already registered — nothing changed.",
        type: "success",
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const addSource = async () => {
    setBusy("source");
    setError(null);
    try {
      await api("/api/statutes/sources", { method: "POST", body: JSON.stringify(newSource) });
      toast({
        title: "Source registered",
        message: `“${newSource.name}” will be checked when you fetch it.`,
        type: "success",
      });
      setNewSource({ key: "", name: "", authority: "cbdt", url: "" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const ingest = async (source: SourceView) => {
    setBusy(source.id);
    setError(null);
    try {
      const res = await api<{ result: { inserted: number; duplicates: number; skipped: number; warnings: string[] } }>(
        "/api/statutes/ingest",
        { method: "POST", body: JSON.stringify({ sourceId: source.id }) },
      );
      toast({
        title: "Feed checked",
        message:
          res.result.inserted > 0
            ? `${res.result.inserted} new item(s) stored, ${res.result.duplicates} already known.`
            : `No new items (${res.result.duplicates} already known, ${res.result.skipped} skipped).`,
        type: res.result.warnings.length > 0 ? "info" : "success",
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const draft = async (notification: NotificationView) => {
    setBusy(notification.id);
    setError(null);
    try {
      const res = await api<{ drafts: DraftView[] }>(`/api/statutes/notifications/${notification.id}/draft`, {
        method: "POST",
        body: JSON.stringify({ ay: ay || null }),
      });
      setDrafts(res.drafts.map((d) => ({ ...d, rowsText: JSON.stringify(d.rows, null, 2) })));
      setDraftFrom(notification.id);
      if (res.drafts.length === 0) {
        toast({ title: "Nothing to draft", message: "No catalogue slot matched this notification.", type: "info" });
      }
    } catch (err) {
      setError(errorMessage(err));
      setDrafts([]);
    } finally {
      setBusy(null);
    }
  };

  const patchDraft = (i: number, p: Partial<DraftView & { rowsText: string }>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));

  const publish = async (d: DraftView & { rowsText: string }) => {
    setError(null);
    if (!d.effectiveFrom) {
      setError("Set an effective date before publishing — every version is dated.");
      return;
    }
    let rows: { upTo: number | null; rate: number; label?: string }[];
    try {
      rows = JSON.parse(d.rowsText) as { upTo: number | null; rate: number; label?: string }[];
    } catch {
      setError("The value rows are not valid JSON. Fix the rows or revert to the carried-forward values.");
      return;
    }
    setBusy(`publish-${d.ruleKey}`);
    try {
      const res = await api<{ version: RuleVersionView; closed: RuleVersionView[] }>("/api/statutes/rules", {
        method: "POST",
        body: JSON.stringify({
          ruleKey: d.ruleKey,
          applicability: d.applicability,
          unit: d.unit,
          rows,
          valueSummary: d.valueSummary || `${d.label} updated`,
          citation: d.citation || "Registered in the rule registry",
          effectiveFrom: d.effectiveFrom,
          effectiveTo: d.effectiveTo,
          notificationId: d.notificationId,
        }),
      });
      toast({
        title: `Published ${res.version.ruleKey} v${res.version.version}`,
        message:
          res.closed.length > 0
            ? `Effective ${res.version.effectiveFrom}. ${res.closed.length} earlier version(s) were closed on the same date — history is preserved.`
            : `Effective ${res.version.effectiveFrom}.`,
        type: "success",
      });
      setDrafts((ds) => ds.filter((x) => x.ruleKey !== d.ruleKey));
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const summary = overview?.summary;

  return (
    <section aria-label="Statute and rate registry" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-h3 text-foreground">
            <BookOpenCheck aria-hidden className="size-5 text-accent" /> Rule &amp; rate registry
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Every rate, slab, threshold and due-date window the engines compute from, with the version in force, the
            authority that published it and the date it took effect. Resolving is always <em>as on</em> a date, so a
            number filed earlier can be reproduced exactly. A slot with nothing in force is shown as{" "}
            <strong className="text-foreground">Not registered</strong> — the app never guesses a statutory value.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="As on" className="w-36">
            <Input type="date" value={asOn} onChange={(e) => setAsOn(e.target.value)} />
          </Field>
          <Field label="Assessment year" className="w-32">
            <Select
              value={ay}
              onChange={(e) => setAy(e.target.value)}
              options={AYS.map((v) => ({ value: v, label: v || "Any" }))}
            />
          </Field>
          <Field label="State" className="w-24">
            <Select
              value={state}
              onChange={(e) => setState(e.target.value)}
              options={STATES.map((v) => ({ value: v, label: v || "Any" }))}
            />
          </Field>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            loading={busy === "load"}
            icon={<RefreshCw aria-hidden className="size-4" />}
          >
            Refresh
          </Button>
          {canAuthor && (
            <Button
              size="sm"
              onClick={() => void seed()}
              loading={busy === "seed"}
              icon={<Download aria-hidden className="size-4" />}
            >
              Seed built-ins
            </Button>
          )}
        </div>
      </div>

      {error && <ErrorMessage title="Could not complete that" message={error} />}

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: "Slots tracked", value: summary.rulesTracked, tone: "default" as const },
            { label: "In force", value: summary.rulesInForce, tone: "success" as const },
            {
              label: "Not registered",
              value: summary.rulesUnresolved,
              tone: summary.rulesUnresolved > 0 ? ("warning" as const) : ("default" as const),
            },
            {
              label: "Notifications to review",
              value: summary.notificationsNew,
              tone: summary.notificationsNew > 0 ? ("warning" as const) : ("default" as const),
            },
            { label: "Sources active", value: summary.sourcesActive, tone: "default" as const },
          ].map((s) => (
            <Card key={s.label} className="p-3">
              <p className="text-caption uppercase tracking-wide text-muted">{s.label}</p>
              <p className="mt-1 flex items-baseline gap-2">
                <span className="text-h3 text-foreground">{s.value}</span>
                {s.tone !== "default" && (
                  <Badge variant={s.tone}>{s.tone === "warning" ? "needs attention" : "ok"}</Badge>
                )}
              </p>
            </Card>
          ))}
        </div>
      )}

      {drafts.length > 0 && (
        <Card className="border-accent/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-h4 text-foreground">Draft rule changes</h3>
            <p className="text-caption text-muted">
              Values are carried forward from the version in force — change only what the notification changed, then
              publish.
            </p>
          </div>
          <div className="mt-3 flex flex-col gap-3">
            {drafts.map((d, i) => (
              <Card key={`${d.ruleKey}-${i}`} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{d.label}</span>
                  <Badge variant="outline">{d.ruleKey}</Badge>
                  <Badge variant="default">{d.unit}</Badge>
                  {d.warnings.map((w) => (
                    <span key={w} className="inline-flex items-center gap-1 text-caption text-amber">
                      <AlertTriangle aria-hidden className="size-3.5" /> {w}
                    </span>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                  <Field label="Effective from" required>
                    <Input
                      type="date"
                      value={d.effectiveFrom ?? ""}
                      onChange={(e) => patchDraft(i, { effectiveFrom: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Value summary" helper="Shown in the registry and copied into evidence.">
                    <Input value={d.valueSummary} onChange={(e) => patchDraft(i, { valueSummary: e.target.value })} />
                  </Field>
                  <Field label="Citation" helper="The gazette/notification reference this version relies on.">
                    <Input value={d.citation} onChange={(e) => patchDraft(i, { citation: e.target.value })} />
                  </Field>
                </div>
                <Field
                  label="Value rows (JSON)"
                  helper="upTo = the upper bound for the row; the last row may be open-ended (null)."
                  className="mt-3"
                >
                  <Textarea value={d.rowsText} onChange={(e) => patchDraft(i, { rowsText: e.target.value })} rows={4} />
                </Field>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-caption text-muted">{rowsSummary(d.rows, d.unit)}</p>
                  <Button
                    size="sm"
                    onClick={() => void publish(d)}
                    loading={busy === `publish-${d.ruleKey}`}
                    disabled={!canAuthor}
                    icon={<Save aria-hidden className="size-4" />}
                  >
                    Publish version
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-h4 text-foreground">Catalogue — what must be kept current</h3>
          <p className="text-caption text-muted">
            As on {overview?.asOn ?? asOn}
            {ay ? ` · AY ${ay}` : ""}
            {state ? ` · ${state}` : ""}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-caption uppercase tracking-wide text-muted">
                <th className="px-4 py-2">Rule slot</th>
                <th className="px-4 py-2">Authority</th>
                <th className="px-4 py-2">In force</th>
                <th className="px-4 py-2">Citation</th>
                <th className="px-4 py-2">Effective</th>
                <th className="px-4 py-2">Versions</th>
              </tr>
            </thead>
            <tbody>
              {(overview?.entries ?? []).map((e) => (
                <tr key={e.key} className="border-b border-line/50 align-top">
                  <td className="px-4 py-2">
                    <p className="font-medium text-foreground">{e.label}</p>
                    <p className="text-caption text-muted">{e.description}</p>
                    <p className="mt-1 font-mono text-caption text-muted">{e.key}</p>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="outline">{e.authority.toUpperCase()}</Badge>
                    <p className="mt-1 text-caption text-muted">{e.cadence}</p>
                  </td>
                  <td className="px-4 py-2">
                    {e.unresolved ? (
                      <Badge variant="warning">Not registered</Badge>
                    ) : (
                      <>
                        <Badge variant="success">v{e.inForce!.version}</Badge>
                        <p className="mt-1 max-w-xs text-caption text-muted">{rowsSummary(e.inForce!.rows, e.unit)}</p>
                        <p className="text-caption text-foreground">{e.inForce!.valueSummary}</p>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2 text-caption text-muted">{e.inForce?.citation ?? "—"}</td>
                  <td className="px-4 py-2 text-caption text-muted">
                    {e.inForce ? (
                      <>
                        {e.inForce.effectiveFrom}
                        {e.inForce.effectiveTo ? ` → ${e.inForce.effectiveTo}` : " → open"}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2 text-caption text-muted">{e.versions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loaded && (overview?.entries.length ?? 0) === 0 && (
          <p className="px-4 py-6 text-sm text-muted">
            No catalogue slots — this build has no rule catalogue registered.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="text-h4 text-foreground">Ingestion sources</h3>
          <p className="mt-1 text-caption text-muted">
            Authority feeds are read-only and fetched server-side. Ingesting stores evidence — it never publishes a
            rule.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {(overview?.sources ?? []).map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 py-2"
              >
                <div>
                  <p className="text-sm text-foreground">
                    {s.name} <Badge variant="outline">{s.authority}</Badge>
                  </p>
                  <p className="font-mono text-caption text-muted">{s.url}</p>
                  <p className="text-caption text-muted">
                    {s.lastCheckedAt ? `Checked ${s.lastCheckedAt.slice(0, 19).replace("T", " ")}` : "Never checked"}
                    {s.lastStatus ? ` · ${s.lastStatus}` : ""}
                    {s.lastError ? ` · ${s.lastError}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canAuthor}
                  loading={busy === s.id}
                  onClick={() => void ingest(s)}
                  icon={<RefreshCw aria-hidden className="size-4" />}
                >
                  Fetch now
                </Button>
              </div>
            ))}
            {(overview?.sources.length ?? 0) === 0 && (
              <p className="text-sm text-muted">No sources yet. Register the CBDT / CBIC / MCA feed you follow.</p>
            )}
          </div>

          {canAuthor && (
            <div className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-3 md:grid-cols-2">
              <Field label="Key" helper="Lowercase, dashes — e.g. cbdt-notifications">
                <Input value={newSource.key} onChange={(e) => setNewSource({ ...newSource, key: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={newSource.name} onChange={(e) => setNewSource({ ...newSource, name: e.target.value })} />
              </Field>
              <Field label="Authority">
                <Select
                  value={newSource.authority}
                  onChange={(e) => setNewSource({ ...newSource, authority: e.target.value })}
                  options={AUTHORITIES.map((a) => ({ value: a, label: a }))}
                />
              </Field>
              <Field label="Feed URL" helper="A JSON feed. HTML pages are not parsed.">
                <Input value={newSource.url} onChange={(e) => setNewSource({ ...newSource, url: e.target.value })} />
              </Field>
              <div className="md:col-span-2">
                <Button
                  size="sm"
                  onClick={() => void addSource()}
                  loading={busy === "source"}
                  icon={<Plus aria-hidden className="size-4" />}
                >
                  Register source
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="text-h4 text-foreground">Ingestion inbox</h3>
          <p className="mt-1 text-caption text-muted">
            Newest first. “Draft change” proposes versions that carry the value in force forward for you to edit.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {(overview?.notifications ?? []).map((n) => (
              <div key={n.id} className="border-b border-line/50 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-foreground">{n.title}</p>
                  <div className="flex items-center gap-2">
                    {statusBadge(n.status)}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!canAuthor}
                      loading={busy === n.id}
                      onClick={() => void draft(n)}
                    >
                      Draft change
                    </Button>
                  </div>
                </div>
                <p className="text-caption text-muted">
                  {n.authority.toUpperCase()}
                  {n.externalId ? ` · ${n.externalId}` : ""}
                  {n.effectiveFrom ? ` · effective ${n.effectiveFrom}` : " · no effective date"}
                  {` · fetched ${n.fetchedAt.slice(0, 10)}`}
                </p>
                <p className="mt-1 text-caption text-muted">{n.excerpt}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {n.impactedRuleKeys.map((k) => (
                    <Badge key={k} variant="info">
                      {k}
                    </Badge>
                  ))}
                  {n.impactedRuleKeys.length === 0 && <Badge variant="warning">no slot matched</Badge>}
                </p>
              </div>
            ))}
            {(overview?.notifications.length ?? 0) === 0 && (
              <p className="text-sm text-muted">
                Nothing ingested yet. Register a source and “Fetch now” — new notifications appear here for review.
              </p>
            )}
          </div>
          {draftFrom && <p className="mt-2 text-caption text-muted">Drafting from notification {draftFrom}.</p>}
        </Card>
      </div>
    </section>
  );
}
