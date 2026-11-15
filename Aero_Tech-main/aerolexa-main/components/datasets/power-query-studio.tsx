"use client";

import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import type { PQStep } from "@/lib/engine/powerquery";
import { editorFor } from "@/lib/engine/powerquery-editors";
import { cn } from "@/lib/utils";

/**
 * Power Query studio (client).
 *
 * Talks to the existing POST /api/datasets/[id]/transform endpoint: it owns
 * the pipeline (auth, workspace check, PQ engine, per-step evaluation). This
 * component owns only step state: ordered list, add/remove/reorder, preview
 * refresh, save. Steps are plain PQStep JSON, so the persisted list is exactly
 * what the engine executes — no client/server drift.
 */

type StudioStep = PQStep;

interface PreviewTable {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
}

interface TransformResponse {
  before: PreviewTable;
  after: PreviewTable;
  steps: { id: string; kind: string; label: string }[];
  note?: string;
}

interface SavedResponse {
  ok?: boolean;
  error?: { message?: string };
}

const STEP_KINDS = [
  { kind: "removeBlankRows", label: "Remove blank rows" },
  { kind: "removeDuplicates", label: "Remove duplicates" },
  { kind: "filterRows", label: "Filter rows" },
  { kind: "sortRows", label: "Sort" },
  { kind: "renameColumn", label: "Rename column" },
  { kind: "changeType", label: "Change type" },
  { kind: "removeColumns", label: "Remove columns" },
  { kind: "trimText", label: "Trim text" },
  { kind: "uppercase", label: "UPPERCASE" },
  { kind: "lowercase", label: "lowercase" },
  { kind: "replaceValues", label: "Replace values" },
  { kind: "fillDown", label: "Fill down" },
  { kind: "splitColumn", label: "Split column" },
  { kind: "mergeColumns", label: "Merge columns" },
  { kind: "groupBy", label: "Group by" },
  { kind: "addCustomColumn", label: "Custom column" },
  { kind: "addIndexColumn", label: "Index column" },
  { kind: "unpivot", label: "Unpivot" },
  { kind: "pivot", label: "Pivot" },
  { kind: "topN", label: "Top N" },
] as const;

let stepSeq = 0;
const nextStepId = () => `s${Date.now().toString(36)}${++stepSeq}`;

/** Minimal builder for the step kinds the palette offers. */
function buildStep(kind: string, columns: string[]): StudioStep {
  const column = columns[0] ?? "";
  const label = STEP_KINDS.find((s) => s.kind === kind)?.label ?? kind;
  switch (kind) {
    case "removeBlankRows":
      return { id: nextStepId(), kind: "removeBlankRows", label };
    case "removeColumns":
    case "removeDuplicates":
      return { id: nextStepId(), kind, label, columns: [column] } as StudioStep;
    case "renameColumn":
      return { id: nextStepId(), kind: "renameColumn", label, from: column, to: `${column}_renamed` };
    case "changeType":
      return { id: nextStepId(), kind: "changeType", label, column, to: "number" };
    case "filterRows":
      return { id: nextStepId(), kind: "filterRows", label, column, op: "isNotEmpty" };
    case "sortRows":
      return { id: nextStepId(), kind: "sortRows", label, column, direction: "asc" };
    case "replaceValues":
      return { id: nextStepId(), kind: "replaceValues", label, column, find: "", replace: "" };
    case "fillDown":
    case "trimText":
    case "uppercase":
    case "lowercase":
      return { id: nextStepId(), kind, label, column } as StudioStep;
    case "splitColumn":
      return { id: nextStepId(), idx: nextStepId(), kind: "splitColumn", label, column, separator: "," };
    case "mergeColumns":
      return { id: nextStepId(), kind: "mergeColumns", label, columns, separator: " ", name: "merged" };
    case "groupBy":
      return {
        id: nextStepId(),
        kind: "groupBy",
        label,
        groupBy: column,
        aggregations: [{ column: null, fn: "count", as: "rowCount" }],
      };
    case "addCustomColumn":
      return { id: nextStepId(), kind: "addCustomColumn", label, name: "custom", expression: "1" };
    case "addIndexColumn":
      return { id: nextStepId(), kind: "addIndexColumn", label, name: "index", start: 1 };
    case "unpivot":
      return {
        id: nextStepId(),
        kind: "unpivot",
        label,
        valueColumns: columns.slice(0, 2),
        nameValue: "attribute",
        nameValueColumn: "value",
      };
    case "pivot":
      return {
        id: nextStepId(),
        kind: "pivot",
        label,
        attributeColumn: column,
        valueColumn: columns[1] ?? column,
        aggregation: "sum",
      };
    case "topN":
      return { id: nextStepId(), kind: "topN", label, column: null, n: 10, direction: "top" };
    default:
      // Unreachable via the fixed palette; keeps the builder total.
      return { id: nextStepId(), kind: "removeBlankRows", label };
  }
}

export function PowerQueryStudio(props: { datasetId: string; datasetName: string; initialSteps: PQStep[] }) {
  const { datasetId, datasetName } = props;
  const [steps, setSteps] = useState<StudioStep[]>(props.initialSteps);
  const [preview, setPreview] = useState<TransformResponse | null>(null);
  const [palette, setPalette] = useState<{ name: string; type: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const runPreview = useCallback(
    async (list: StudioStep[]) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/datasets/${datasetId}/transform`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steps: list, limit: 100 }),
        });
        const body = (await res.json()) as { data?: TransformResponse; error?: { message?: string } };
        if (!res.ok) {
          setError(body.error?.message ?? `Preview failed (${res.status}).`);
          return;
        }
        if (body.data) {
          setPreview(body.data);
          setPalette(body.data.before.columns);
        }
      } catch {
        setError("Network error while running the preview.");
      } finally {
        setLoading(false);
      }
    },
    [datasetId],
  );

  useEffect(() => {
    void runPreview(steps);
    // Initial preview + re-run whenever the step list changes (explicit user action).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutate = (next: StudioStep[]) => {
    setSteps(next);
    void runPreview(next);
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    mutate(next);
  };

  const addStep = (kind: string) => {
    const step = buildStep(
      kind,
      palette.map((c) => c.name),
    );
    mutate([...steps, step]);
    setEditingId(step.id); // open the editor immediately — defaults are just a starting point
  };

  const patchStep = (id: string, key: string, value: unknown) => {
    const next = steps.map((s) => (s.id === id ? ({ ...s, [key]: value } as StudioStep) : s));
    mutate(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/datasets/${datasetId}/transform/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
      });
      if (res.ok) {
        setSavedAt(new Date().toLocaleTimeString());
      } else {
        const body = (await res.json()) as SavedResponse;
        setError(body.error?.message ?? `Save failed (${res.status}).`);
      }
    } catch {
      setError("Network error while saving.");
    } finally {
      setSaving(false);
    }
  };

  const delta = useMemo(() => {
    if (!preview) return null;
    return preview.before.totalRows - preview.after.totalRows;
  }, [preview]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Transform — Power Query studio</h1>
          <p className="text-sm text-muted">
            Applied steps run on a preview of “{datasetName}”. The source file is never modified.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && <span className="text-caption text-muted">Saved {savedAt}</span>}
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving}
            icon={saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          >
            Save steps
          </Button>
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Applied steps */}
        <aside aria-label="Applied steps" className="rounded-2xl border border-line bg-surface p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Applied steps</h2>
            <span className="text-caption text-muted">{steps.length}</span>
          </div>

          <ol className="mb-3 space-y-1.5">
            {steps.length === 0 && <li className="px-2 py-1 text-caption text-muted">Source — no steps yet.</li>}
            {steps.map((s, i) => (
              <li key={s.id} className="rounded-lg border border-line bg-surface-2 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate rounded text-left text-caption text-foreground hover:text-accent"
                    title={`Edit: ${s.label}`}
                    onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                  >
                    {i + 1}. {s.label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} up`}
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="rounded p-0.5 text-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${i + 1} down`}
                    onClick={() => move(i, 1)}
                    disabled={i === steps.length - 1}
                    className="rounded p-0.5 text-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowDown className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => mutate(steps.filter((x) => x.id !== s.id))}
                    className="rounded p-0.5 text-muted hover:text-foreground"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {editingId === s.id && (
                  <StepEditor
                    step={s}
                    columns={palette.map((c) => c.name)}
                    onPatch={(key, value) => patchStep(s.id, key, value)}
                    onClose={() => setEditingId(null)}
                  />
                )}
              </li>
            ))}
          </ol>

          <h3 className="mb-1.5 text-caption font-semibold text-muted">Add a step</h3>
          <div className="flex flex-wrap gap-1.5">
            {STEP_KINDS.map((s) => (
              <button
                key={s.kind}
                type="button"
                onClick={() => addStep(s.kind)}
                disabled={palette.length === 0}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-caption text-foreground hover:border-accent disabled:opacity-40"
              >
                <Plus className="size-3" />
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-caption text-muted">
            Click a step to edit its parameters — every change re-runs the preview against the real engine.
          </p>
        </aside>

        {/* Preview */}
        <section aria-label="Preview" className="min-w-0 rounded-2xl border border-line bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Before → after preview</h2>
            {preview && (
              <div className="flex items-center gap-2">
                <Badge>before {preview.before.totalRows.toLocaleString()} rows</Badge>
                <Badge>{preview.after.totalRows.toLocaleString()} rows</Badge>
                {delta !== null && delta !== 0 && (
                  <span className="text-caption text-muted">
                    {delta > 0 ? `−${delta.toLocaleString()}` : `+${Math.abs(delta).toLocaleString()}`} vs source
                  </span>
                )}
                {loading && <Loader2 className="size-3.5 animate-spin text-muted" />}
              </div>
            )}
          </div>

          {preview ? (
            <DataTable
              columns={preview.after.columns.map((c) => ({ key: c.name, label: c.name }))}
              rows={preview.after.rows.map((row) => row.map((v) => (v === null ? null : String(v))))}
            />
          ) : (
            <EmptyState title="Loading preview…" description="Reading the first rows of the dataset." />
          )}
          {preview?.note && <p className="mt-2 text-caption text-muted">{preview.note}</p>}
        </section>
      </div>
    </div>
  );
}

/**
 * Per-step editor (Gap ⑤). Rendered from the data-driven STEP_EDITORS schema:
 * column dropdowns populate from the dataset's real columns, aggregations
 * and filter ops are constrained selects, and every patch re-runs the live
 * preview through the real engine server-side.
 */
function StepEditor({
  step,
  columns,
  onPatch,
  onClose,
}: {
  step: StudioStep;
  columns: string[];
  onPatch: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const spec = editorFor(step.kind);
  if (!spec) return null;

  const inputCls =
    "w-full rounded-lg border border-line bg-surface px-2 py-1 text-caption text-foreground outline-none focus:border-accent";

  return (
    <div
      className="mt-1.5 space-y-1.5 rounded-lg border border-line bg-surface p-2"
      role="group"
      aria-label={`Edit step: ${spec.title}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-caption font-semibold text-foreground">{spec.title}</span>
        <button
          type="button"
          aria-label="Close editor"
          onClick={onClose}
          className="rounded p-0.5 text-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {spec.fields.map((field) => {
        const raw = (step as unknown as Record<string, unknown>)[field.key];
        if (field.control === "column") {
          return (
            <label key={field.key} className="block">
              <span className="text-caption text-muted">{field.label}</span>
              <select
                value={String(raw ?? "")}
                onChange={(e) => onPatch(field.key, e.target.value)}
                className={inputCls}
              >
                <option value="">—</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (field.control === "columns") {
          const selected = Array.isArray(raw) ? (raw as string[]) : [];
          return (
            <fieldset key={field.key} className="flex flex-wrap gap-1">
              <legend className="text-caption text-muted">{field.label}</legend>
              {columns.map((c) => {
                const on = selected.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onPatch(field.key, on ? selected.filter((x) => x !== c) : [...selected, c])}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-caption",
                      on
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface text-muted hover:text-foreground",
                    )}
                  >
                    {c}
                  </button>
                );
              })}
            </fieldset>
          );
        }
        if (field.control === "select") {
          return (
            <label key={field.key} className="block">
              <span className="text-caption text-muted">{field.label}</span>
              <select
                value={String(raw ?? field.options[0]?.value ?? "")}
                onChange={(e) => onPatch(field.key, e.target.value)}
                className={inputCls}
              >
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (field.control === "number") {
          return (
            <label key={field.key} className="block">
              <span className="text-caption text-muted">{field.label}</span>
              <input
                type="number"
                value={typeof raw === "number" ? raw : 0}
                min={field.min}
                max={field.max}
                onChange={(e) => onPatch(field.key, Number(e.target.value))}
                className={inputCls}
              />
            </label>
          );
        }
        if (field.control === "aggSpec") {
          const aggs = Array.isArray(raw) ? (raw as { column: string | null; fn: string; as: string }[]) : [];
          return (
            <fieldset key={field.key} className="space-y-1">
              <legend className="text-caption text-muted">{field.label}</legend>
              {aggs.map((a, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select
                    value={a.fn}
                    onChange={(e) => {
                      const next = aggs.map((x, j) => (j === i ? { ...x, fn: e.target.value } : x));
                      onPatch(field.key, next);
                    }}
                    className={inputCls}
                    aria-label={`Aggregation function ${i + 1}`}
                  >
                    {["sum", "avg", "count", "countDistinct", "min", "max", "median", "stddev", "first", "last"].map(
                      (fn) => (
                        <option key={fn} value={fn}>
                          {fn}
                        </option>
                      ),
                    )}
                  </select>
                  <select
                    value={a.column ?? ""}
                    onChange={(e) => {
                      const col = e.target.value || null;
                      const next = aggs.map((x, j) => (j === i ? { ...x, column: col } : x));
                      onPatch(field.key, next);
                    }}
                    className={inputCls}
                    aria-label={`Aggregation column ${i + 1}`}
                  >
                    <option value="">(rows)</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={a.as}
                    placeholder="as"
                    onChange={(e) => {
                      const next = aggs.map((x, j) => (j === i ? { ...x, as: e.target.value } : x));
                      onPatch(field.key, next);
                    }}
                    className={inputCls}
                    aria-label={`Output name ${i + 1}`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove aggregation ${i + 1}`}
                    onClick={() =>
                      onPatch(
                        field.key,
                        aggs.filter((_, j) => j !== i),
                      )
                    }
                    className="rounded p-0.5 text-muted hover:text-foreground"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  onPatch(field.key, [...aggs, { column: null, fn: "count", as: `agg${aggs.length + 1}` }])
                }
                className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-caption text-foreground hover:border-accent"
              >
                <Plus className="size-3" /> Add aggregation
              </button>
            </fieldset>
          );
        }
        // text / value
        return (
          <label key={field.key} className="block">
            <span className="text-caption text-muted">{field.label}</span>
            <input
              type="text"
              value={raw === null || raw === undefined ? "" : String(raw)}
              placeholder={field.control === "text" ? field.placeholder : ""}
              onChange={(e) => {
                const text = e.target.value;
                // value-controls feed the engine's PQValue: keep numbers numeric
                // when the text parses, so `gt 10` compares numerically.
                onPatch(field.key, text !== "" && text !== "-" && !Number.isNaN(Number(text)) ? Number(text) : text);
              }}
              className={inputCls}
            />
          </label>
        );
      })}
    </div>
  );
}
