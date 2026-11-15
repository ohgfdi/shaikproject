"use client";

import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/client/api";
import type { CaMappingProfile, CaSourceKind } from "@/lib/engine/ca-source";
import type { ColType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Wire shapes — mirror lib/server/ca-source.ts
// ---------------------------------------------------------------------------

export interface CaSourceSummary {
  id: string;
  sourceKind: string;
  sourceLabel: string;
  displayName: string | null;
  engagementId: string | null;
  profile: string; // JSON CaMappingProfile
  sourceColumns: string[];
  syncCount: number;
  lastIngestedAt: string | null;
  lastError: string | null;
  documentFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CaIngestRunRow {
  id: string;
  syncVersion: string;
  status: string;
  rowCount: number | null;
  documentCount: number | null;
  report: string | null;
  reconciliation: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface CaDocumentRow {
  fingerprint: string;
  rowIndex: number;
  document: unknown;
}

interface ReconcileEnvelope {
  totalMatched: number;
  matchRate: number;
  summary: { note: string; matchedTotal: number; unmatchedLeftTotal: number; unmatchedRightTotal: number };
}

interface IngestResult {
  run: CaIngestRunRow;
  documents: CaDocumentRow[];
  reconciliation: ReconcileEnvelope | null;
}

type Mapping = CaMappingProfile["mapping"];
type MetadataMapping = NonNullable<Mapping["metadata"]>;
type SimpleMappingKey = Exclude<keyof Mapping, "metadata">;

/** What the profile routes accept: the id/timestamp are filled server-side when absent. */
type ProfilePayload = Omit<CaMappingProfile, "id" | "firstUsedAt"> & {
  id?: string;
  firstUsedAt?: string;
};

// ---------------------------------------------------------------------------
// Mapping editor definitions
// ---------------------------------------------------------------------------

const MAPPING_FIELDS: { key: SimpleMappingKey; label: string; hint: string }[] = [
  {
    key: "fingerprint",
    label: "Fingerprint (identity)",
    hint: "Stable identity across repeat syncs. At least this must resolve.",
  },
  { key: "traceLabel", label: "Trace label", hint: "The reference a reviewer cites in working papers." },
  { key: "date", label: "Date", hint: "yyyy-mm-dd." },
  { key: "party", label: "Party / ledger", hint: "Ledger, party or narration." },
  { key: "account", label: "Account / group", hint: "Group, HSN, SAC or section." },
  { key: "debit", label: "Debit", hint: "Debit amount in rupees." },
  { key: "credit", label: "Credit", hint: "Credit amount in rupees." },
  { key: "sourceAmount", label: "Source amount", hint: "The total the source carries (rupees)." },
  { key: "sourceId", label: "Source id", hint: "GSTIN / IRN / challan serial / txn id." },
];

const METADATA_FIELDS: { key: keyof MetadataMapping; label: string }[] = [
  { key: "igst", label: "IGST" },
  { key: "cgst", label: "CGST" },
  { key: "sgst", label: "SGST" },
  { key: "cess", label: "Cess" },
  { key: "section", label: "Section" },
  { key: "head", label: "Head" },
  { key: "netPay", label: "Net pay" },
  { key: "rate", label: "Rate" },
  { key: "hsn", label: "HSN" },
  { key: "sac", label: "SAC" },
  { key: "status", label: "Status" },
];

const METADATA_PREFIX = "metadata.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProfile(raw: string): CaMappingProfile | null {
  try {
    const value = JSON.parse(raw) as CaMappingProfile;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const cls = tone === "warn" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-sky-300 bg-sky-50 text-sky-800";
  return <div className={`rounded-md border px-3 py-2 text-[13px] ${cls}`}>{children}</div>;
}

function inferColumnType(values: string[]): ColType {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return "string";
  if (nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return "date";
  if (nonEmpty.every((v) => v === "true" || v === "false")) return "boolean";
  if (nonEmpty.every((v) => /^-?[\d,]+(\.\d+)?$/.test(v))) return "number";
  return "string";
}

/** Parse a pasted/uploaded CSV into the columns + rows shape the ingest route takes. */
function parseCsv(text: string): { columns: { name: string; type: ColType }[]; rows: (string | null)[][] } | null {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const data = parsed.data.filter((row) => row.some((cell) => (cell ?? "").trim() !== ""));
  if (data.length < 2) return null;
  const header = (data[0] ?? []).map((h) => (h ?? "").trim());
  if (header.length === 0 || header.some((h) => h === "")) return null;
  const body = data.slice(1);
  const columns = header.map((name, i) => ({ name, type: inferColumnType(body.map((row) => row[i] ?? "")) }));
  const rows = body.map((row) =>
    header.map((_, i) => {
      const value = (row[i] ?? "").trim();
      return value === "" ? null : value;
    }),
  );
  return { columns, rows };
}

function money(rupees: number): string {
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN");
}

/** Empty editor state: every canonical field unmapped. */
function emptyMapping(): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of MAPPING_FIELDS) next[field.key] = "";
  for (const field of METADATA_FIELDS) next[`${METADATA_PREFIX}${field.key}`] = "";
  return next;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function CaSourcesWorkspace({
  initialSources,
  kinds,
  engagements,
}: {
  initialSources: CaSourceSummary[];
  kinds: readonly CaSourceKind[];
  engagements: { id: string; name: string; code: string | null }[];
}) {
  const { toast } = useToast();
  const [sources, setSources] = useState<CaSourceSummary[]>(initialSources);
  const [selectedId, setSelectedId] = useState<string | null>(initialSources[0]?.id ?? null);
  const [tab, setTab] = useState<"ingest" | "mapping" | "runs">("ingest");
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => sources.find((s) => s.id === selectedId) ?? null, [sources, selectedId]);

  // ---------------------------------------------------------------- create
  const [createOpen, setCreateOpen] = useState(initialSources.length === 0);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    sourceKind: (kinds[0] ?? "tally-vouchers") as CaSourceKind,
    sourceLabel: "",
    displayName: "",
    engagementId: "",
  });

  const createSource = async () => {
    if (!createForm.sourceLabel.trim()) {
      setError("A source label (the file or system name) is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ source: CaSourceSummary }>("/api/ca/sources", {
        method: "POST",
        body: JSON.stringify({
          sourceKind: createForm.sourceKind,
          sourceLabel: createForm.sourceLabel.trim(),
          displayName: createForm.displayName.trim() || null,
          engagementId: createForm.engagementId || null,
        }),
      });
      setSources((prev) => [res.source, ...prev]);
      setSelectedId(res.source.id);
      setCreateForm((f) => ({ ...f, sourceLabel: "", displayName: "" }));
      setCreateOpen(false);
      toast({ title: "CA source created", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const refreshSources = useCallback(async () => {
    try {
      const res = await api<{ sources: CaSourceSummary[] }>("/api/ca/sources");
      setSources(res.sources);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  // ---------------------------------------------------------------- ingest
  const [csvText, setCsvText] = useState("");
  const [reconcile, setReconcile] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);

  const parsed = useMemo(() => (csvText.trim() ? parseCsv(csvText) : null), [csvText]);

  const ingest = async () => {
    if (!selected) return;
    if (!parsed) {
      setError("Paste a CSV with a header row and at least one data row (or choose a file).");
      return;
    }
    setIngesting(true);
    setError(null);
    try {
      const res = await api<IngestResult>(`/api/ca/sources/${selected.id}/ingest`, {
        method: "POST",
        body: JSON.stringify({ sourceRows: parsed, reconcileAgainstPrior: reconcile }),
      });
      setResult(res);
      toast({
        title: `Ingest ${res.run.status.toLowerCase()}`,
        message: `${res.run.documentCount ?? 0} document(s) captured.`,
        type: res.run.status === "SUCCESS" ? "success" : "error",
      });
      await refreshSources();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIngesting(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsvText(await file.text());
  };

  // ---------------------------------------------------------------- mapping
  const [mapping, setMapping] = useState<Record<string, string>>(() => emptyMapping());
  const [profileName, setProfileName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [library, setLibrary] = useState<CaMappingProfile[]>([]);

  useEffect(() => {
    const src = sources.find((s) => s.id === selectedId) ?? null;
    const profile = src ? parseProfile(src.profile) : null;
    const next = emptyMapping();
    if (profile) {
      for (const field of MAPPING_FIELDS) next[field.key] = profile.mapping?.[field.key]?.column ?? "";
      for (const field of METADATA_FIELDS) {
        next[`${METADATA_PREFIX}${field.key}`] = profile.mapping?.metadata?.[field.key]?.column ?? "";
      }
    }
    setMapping(next);
    setProfileName(profile?.name ?? (src ? `auto-${src.sourceKind}` : ""));
  }, [sources, selectedId]);

  const availableColumns = useMemo(() => {
    const set = new Set<string>(selected?.sourceColumns ?? []);
    for (const col of parsed?.columns ?? []) set.add(col.name);
    return Array.from(set);
  }, [selected, parsed]);

  const loadLibrary = useCallback(async (kind: string) => {
    try {
      const res = await api<{ profiles: CaMappingProfile[] }>(
        `/api/ca/mapping-profiles?sourceKind=${encodeURIComponent(kind)}`,
      );
      setLibrary(res.profiles);
    } catch {
      /* the library is a convenience; a failure must not block ingestion */
    }
  }, []);

  useEffect(() => {
    if (selected && tab === "mapping") void loadLibrary(selected.sourceKind);
  }, [selected, tab, loadLibrary]);

  const buildProfile = (): ProfilePayload | null => {
    if (!selected || availableColumns.length === 0) return null;
    const payload: ProfilePayload = {
      name: profileName.trim() || `profile-${selected.sourceKind}`,
      sourceKind: selected.sourceKind as CaSourceKind,
      sourceLabel: selected.sourceLabel,
      sourceColumns: availableColumns,
      mapping: {},
      note: null,
    };
    for (const field of MAPPING_FIELDS) {
      const column = mapping[field.key];
      if (column) payload.mapping[field.key] = { column };
    }
    const metadata: MetadataMapping = {};
    for (const field of METADATA_FIELDS) {
      const column = mapping[`${METADATA_PREFIX}${field.key}`];
      if (column) metadata[field.key] = { column };
    }
    if (Object.keys(metadata).length > 0) payload.mapping.metadata = metadata;
    return payload;
  };

  const saveProfile = async (share: boolean) => {
    if (!selected) return;
    const profile = buildProfile();
    if (!profile) {
      setError("Load or paste the source columns first — a profile maps columns to canonical fields.");
      return;
    }
    setSavingProfile(true);
    setError(null);
    try {
      const res = await api<{ source: CaSourceSummary }>(`/api/ca/sources/${selected.id}/profile`, {
        method: "PUT",
        body: JSON.stringify(profile),
      });
      setSources((prev) => prev.map((s) => (s.id === res.source.id ? res.source : s)));
      if (share) {
        await api("/api/ca/mapping-profiles", { method: "POST", body: JSON.stringify(profile) });
        await loadLibrary(selected.sourceKind);
      }
      toast({ title: share ? "Saved to the source and the library" : "Mapping saved", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const applyLibraryProfile = (profile: CaMappingProfile) => {
    const next = emptyMapping();
    for (const field of MAPPING_FIELDS) next[field.key] = profile.mapping?.[field.key]?.column ?? "";
    for (const field of METADATA_FIELDS) {
      next[`${METADATA_PREFIX}${field.key}`] = profile.mapping?.metadata?.[field.key]?.column ?? "";
    }
    setMapping(next);
    setProfileName(profile.name);
  };

  const deleteLibraryProfile = async (id: string) => {
    if (!selected) return;
    try {
      await api(`/api/ca/mapping-profiles/${id}`, { method: "DELETE" });
      await loadLibrary(selected.sourceKind);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // ---------------------------------------------------------------- runs
  const [runs, setRuns] = useState<CaIngestRunRow[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<CaDocumentRow[]>([]);

  const loadRuns = useCallback(async (sourceId: string) => {
    setLoadingRuns(true);
    try {
      const res = await api<{ runs: CaIngestRunRow[] }>(`/api/ca/sources/${sourceId}/runs`);
      setRuns(res.runs);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    if (selected && tab === "runs") void loadRuns(selected.id);
  }, [selected, tab, loadRuns]);

  const openRun = async (runId: string) => {
    if (!selected) return;
    setOpenRunId(runId);
    setDocuments([]);
    try {
      const res = await api<{ documents: CaDocumentRow[] }>(`/api/ca/sources/${selected.id}/documents?runId=${runId}`);
      setDocuments(res.documents);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const lastReconcile = result?.reconciliation ?? null;

  // ---------------------------------------------------------------- render
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Sources</h2>
          <Button size="sm" variant="secondary" onClick={() => setCreateOpen((v) => !v)}>
            {createOpen ? "Cancel" : "New"}
          </Button>
        </div>

        {createOpen && (
          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <Select
              label="Source kind"
              value={createForm.sourceKind}
              onChange={(e) => setCreateForm((f) => ({ ...f, sourceKind: e.target.value as CaSourceKind }))}
              options={kinds.map((k) => ({ value: k, label: k }))}
            />
            <Input
              label="Source label"
              value={createForm.sourceLabel}
              onChange={(e) => setCreateForm((f) => ({ ...f, sourceLabel: e.target.value }))}
              placeholder="daybook-mar26.csv"
            />
            <Input
              label="Display name"
              value={createForm.displayName}
              onChange={(e) => setCreateForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Tally Day Book — Mar-26"
            />
            {engagements.length > 0 && (
              <Select
                label="Engagement"
                value={createForm.engagementId}
                onChange={(e) => setCreateForm((f) => ({ ...f, engagementId: e.target.value }))}
                placeholder="Firm-level (no engagement)"
                options={engagements.map((eng) => ({
                  value: eng.id,
                  label: eng.code ? `${eng.name} (${eng.code})` : eng.name,
                }))}
              />
            )}
            <Button disabled={creating} onClick={() => void createSource()}>
              {creating ? "Creating…" : "Create source"}
            </Button>
          </div>
        )}

        {sources.length === 0 ? (
          <p className="text-sm text-neutral-500">No CA sources yet.</p>
        ) : (
          <ul className="space-y-1">
            {sources.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(s.id);
                    setResult(null);
                  }}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                    s.id === selectedId
                      ? "bg-neutral-900 text-white"
                      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  }`}
                >
                  <div className="font-medium">{s.displayName ?? s.sourceLabel}</div>
                  <div className={`text-xs ${s.id === selectedId ? "text-neutral-300" : "text-neutral-500"}`}>
                    {s.sourceKind} · {s.syncCount} sync(s)
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="space-y-4">
        {error && <Banner tone="warn">{error}</Banner>}

        {!selected ? (
          <p className="text-sm text-neutral-500">Create or select a source to ingest its data.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{selected.displayName ?? selected.sourceLabel}</div>
                <div className="text-xs text-neutral-500">
                  {selected.sourceKind} · {selected.sourceLabel} · last ingest {formatTs(selected.lastIngestedAt)}
                </div>
                {selected.lastError && (
                  <div className="mt-1 text-xs text-amber-700">Last error: {selected.lastError}</div>
                )}
              </div>
              <div className="flex gap-1">
                {(["ingest", "mapping", "runs"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      tab === t ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                    }`}
                  >
                    {t === "ingest" ? "Ingest" : t === "mapping" ? "Mapping" : "Runs & documents"}
                  </button>
                ))}
              </div>
            </div>

            {tab === "ingest" && (
              <div className="space-y-3">
                <p className="text-xs text-neutral-500">
                  Paste the source rows as CSV (header row first) or choose a file. Values stay as text; the engine
                  parses amounts and dates through the saved mapping profile.
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="text-sm"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                />
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  rows={7}
                  placeholder={"voucher_number,date,amount\nV-101,2026-03-01,1000.00"}
                  className="w-full rounded-md border border-neutral-300 p-2 font-mono text-xs"
                />
                {csvText.trim() !== "" && !parsed && (
                  <Banner tone="warn">That CSV needs a header row and at least one data row.</Banner>
                )}
                {parsed && (
                  <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
                    Detected {parsed.columns.length} column(s) and {parsed.rows.length} row(s):{" "}
                    {parsed.columns.map((c) => `${c.name} (${c.type})`).join(", ")}
                  </div>
                )}
                <Checkbox
                  label="Reconcile against the prior ingest"
                  description="When a prior successful sync exists, match the new documents against it and record the summary."
                  checked={reconcile}
                  onChange={setReconcile}
                />
                <Button disabled={ingesting || !parsed} onClick={() => void ingest()}>
                  {ingesting ? "Ingesting…" : "Ingest source rows"}
                </Button>

                {result && (
                  <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3">
                    <div className="text-sm font-medium">
                      Run {result.run.syncVersion} · {result.run.status}
                    </div>
                    <div className="text-xs text-neutral-600">
                      {result.run.rowCount ?? 0} row(s) → {result.run.documentCount ?? 0} document(s)
                      {result.run.error ? ` · ${result.run.error}` : ""}
                    </div>
                    {lastReconcile && (
                      <div className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-700">
                        <div className="font-medium">
                          Reconciliation: {lastReconcile.totalMatched} matched ({lastReconcile.matchRate}%)
                        </div>
                        <div className="mt-1">{lastReconcile.summary.note}</div>
                      </div>
                    )}
                    {result.documents.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer font-medium text-neutral-700">
                          Documents produced ({result.documents.length})
                        </summary>
                        <ul className="mt-1 space-y-0.5 font-mono">
                          {result.documents.slice(0, 50).map((doc) => (
                            <li key={doc.fingerprint}>
                              row {doc.rowIndex} · {doc.fingerprint}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "mapping" && (
              <div className="space-y-3">
                <p className="text-xs text-neutral-500">
                  Map each canonical field to a source column. The profile is saved on the source and reused on every
                  repeat sync — this is what makes ingestion a pipeline rather than a one-off import.
                </p>
                {availableColumns.length === 0 && (
                  <Banner tone="warn">
                    No source columns known yet. Paste a CSV on the Ingest tab (or create the source with columns) to
                    populate the picker.
                  </Banner>
                )}
                <Input
                  label="Profile name"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="HDFC SB — Apr-26"
                />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {MAPPING_FIELDS.map((field) => (
                    <Select
                      key={field.key}
                      label={field.label}
                      value={mapping[field.key] ?? ""}
                      onChange={(e) => setMapping((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      placeholder="— not mapped —"
                      options={availableColumns.map((c) => ({ value: c, label: c }))}
                      helper={field.hint}
                    />
                  ))}
                </div>
                <details className="rounded border border-neutral-200 bg-neutral-50 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-neutral-700">
                    Metadata columns (optional)
                  </summary>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                    {METADATA_FIELDS.map((field) => {
                      const key = `${METADATA_PREFIX}${field.key}`;
                      return (
                        <Select
                          key={key}
                          label={field.label}
                          value={mapping[key] ?? ""}
                          onChange={(e) => setMapping((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="— not mapped —"
                          options={availableColumns.map((c) => ({ value: c, label: c }))}
                        />
                      );
                    })}
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={savingProfile} onClick={() => void saveProfile(false)}>
                    {savingProfile ? "Saving…" : "Save mapping on source"}
                  </Button>
                  <Button variant="secondary" disabled={savingProfile} onClick={() => void saveProfile(true)}>
                    Save + add to library
                  </Button>
                </div>

                <div className="rounded-lg border border-neutral-200 bg-white p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Saved profiles for {selected.sourceKind}
                  </div>
                  {library.length === 0 ? (
                    <p className="mt-2 text-xs text-neutral-500">No saved profiles for this source kind yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {library.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            {p.name}
                            <span className="ml-2 text-xs text-neutral-400">{p.sourceColumns.length} column(s)</span>
                          </span>
                          <span className="flex gap-1">
                            <Button size="sm" variant="secondary" onClick={() => applyLibraryProfile(p)}>
                              Load
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => void deleteLibraryProfile(p.id)}>
                              Delete
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {tab === "runs" && (
              <div className="space-y-3">
                <Button size="sm" variant="secondary" onClick={() => void loadRuns(selected.id)}>
                  {loadingRuns ? "Loading…" : "Refresh runs"}
                </Button>
                {runs.length === 0 ? (
                  <p className="text-sm text-neutral-500">No ingest runs yet for this source.</p>
                ) : (
                  <ul className="space-y-2">
                    {runs.map((run) => (
                      <li key={run.id} className="rounded-lg border border-neutral-200 bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm">
                            <span className="font-medium">Sync {run.syncVersion}</span>{" "}
                            <span
                              className={
                                run.status === "SUCCESS"
                                  ? "text-emerald-700"
                                  : run.status === "ERROR"
                                    ? "text-amber-700"
                                    : "text-neutral-500"
                              }
                            >
                              {run.status}
                            </span>
                            <span className="ml-2 text-xs text-neutral-500">
                              {run.documentCount ?? 0} document(s) · {formatTs(run.startedAt)}
                            </span>
                          </div>
                          <Button size="sm" variant="secondary" onClick={() => void openRun(run.id)}>
                            Documents
                          </Button>
                        </div>
                        {run.error && <div className="mt-1 text-xs text-amber-700">{run.error}</div>}
                        {run.reconciliation && (
                          <details className="mt-1 text-xs">
                            <summary className="cursor-pointer font-medium text-neutral-700">Reconciliation</summary>
                            <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 text-[11px]">
                              {JSON.stringify(JSON.parse(run.reconciliation), null, 2)}
                            </pre>
                          </details>
                        )}
                        {openRunId === run.id && (
                          <div className="mt-2 border-t border-neutral-100 pt-2">
                            {documents.length === 0 ? (
                              <p className="text-xs text-neutral-500">No documents recorded for this run.</p>
                            ) : (
                              <ul className="space-y-1 font-mono text-[11px]">
                                {documents.map((doc) => {
                                  const amount =
                                    doc.document !== null &&
                                    typeof doc.document === "object" &&
                                    "sourceAmount" in doc.document
                                      ? Number((doc.document as { sourceAmount: unknown }).sourceAmount)
                                      : null;
                                  return (
                                    <li key={doc.fingerprint}>
                                      row {doc.rowIndex} · {doc.fingerprint}
                                      {amount !== null && Number.isFinite(amount) ? ` · ${money(amount)}` : ""}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
