"use client";

/**
 * Model panel — the semantic-layer editor UI.
 *
 * Shows the project's model as Power BI would: tables (datasets), a
 * relationship diagram-lite (many[table][key] → one[table][key] with
 * star-schema validation badges), and the measures list. Editors can:
 *   - remove relationships (creating/editing joins stays in the Datasets tab
 *     flow it already exists in — this panel links there)
 *   - create measures bound to a dataset with a name + simple DAX expression
 *   - evaluate any measure live with an optional RELATED() dimension filter
 *     and an optional row filter, seeing exactly which filters were applied
 *
 * Every number shown is computed server-side from the real rows through
 * lib/server/semantic-model.ts — nothing is mocked in this panel.
 */

import { GitBranch, Link2, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { buildMeasureLineage, measuresReading, type MeasureDependencies } from "@/lib/engine/measure-lineage";

interface ModelTables {
  name: string;
  datasetId: string;
  rowCount: number;
  columns: { name: string; type: string }[];
}
interface ModelRelationship {
  id: string;
  name: string;
  manyTable: string;
  manyColumn: string;
  oneTable: string;
  oneColumn: string;
  warnings: string[];
}
interface ModelMeasure {
  id: string;
  name: string;
  description: string | null;
  daxExpression: string;
  format: string;
  datasetId: string | null;
  datasetName: string | null;
}
interface ModelIssue {
  severity: "error" | "warning";
  relationship: string;
  message: string;
}
interface ModelData {
  tables: ModelTables[];
  relationships: ModelRelationship[];
  measures: ModelMeasure[];
  issues: ModelIssue[];
}

interface EvalResponse {
  value: number | null;
  applied: string[];
  rowsUsed: number;
}

const AGGREGATIONS = ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "DISTINCTCOUNT"] as const;

export function ModelPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [model, setModel] = useState<ModelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Measure form
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aggregation, setAggregation] = useState<(typeof AGGREGATIONS)[number]>("SUM");
  const [column, setColumn] = useState("");
  const [measureTable, setMeasureTable] = useState("");
  const [busy, setBusy] = useState(false);

  // Evaluate form
  const [evalMeasure, setEvalMeasure] = useState("");
  const [evalRel, setEvalRel] = useState("");
  const [evalDimValues, setEvalDimValues] = useState("");
  const [evalRowCol, setEvalRowCol] = useState("");
  const [evalRowValue, setEvalRowValue] = useState("");
  const [evalResult, setEvalResult] = useState<EvalResponse | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  // Lineage pane: which measure's dependency view is expanded.
  const [lineageFor, setLineageFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setModel(await api<ModelData>(`/api/projects/${projectId}/model`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Lineage (ROADMAP 2.3): pure in-browser parsing of the real stored
  // expressions — no extra API round-trip, always in sync with the list above.
  // Computed unconditionally (before any early return) to keep hook order stable.
  const lineage = useMemo(
    () =>
      model
        ? buildMeasureLineage(
            model.measures.map((m) => ({ name: m.name, expression: m.daxExpression })),
            model.tables.flatMap((t) => t.columns.map((c) => c.name)),
          )
        : new Map<string, MeasureDependencies>(),
    [model],
  );

  const chosenTable = model?.tables.find((t) => t.name === measureTable);
  const numericColumns = chosenTable?.columns.filter((c) => c.type === "number") ?? [];
  const factTableForRel = model?.tables.find(
    (t) => t.name === model?.relationships.find((r) => r.id === evalRel)?.manyTable,
  );
  const rowColumnCandidates = factTableForRel?.columns ?? chosenTable?.columns ?? model?.tables[0]?.columns ?? [];

  const createMeasure = async () => {
    if (!name.trim() || !measureTable || !column) {
      toast({
        title: "Missing fields",
        message: "Pick a dataset, a column and give the measure a name.",
        type: "error",
      });
      return;
    }
    setBusy(true);
    try {
      await api(`/api/datasets/${chosenTable!.datasetId}/custom-metrics`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          daxExpression: `${aggregation}([${column}])`,
          format: "number",
        }),
      });
      toast({ title: "Measure created", message: `${name.trim()} = ${aggregation}([${column}])`, type: "success" });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setColumn("");
      await load();
    } catch (err) {
      toast({ title: "Could not create measure", message: errorMessage(err), type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const deleteRelationship = async (relationshipId: string) => {
    try {
      await api(`/api/projects/${projectId}/model/relationships/${relationshipId}`, { method: "DELETE" });
      toast({ title: "Relationship removed", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not remove relationship", message: errorMessage(err), type: "error" });
    }
  };

  const evaluate = async () => {
    setEvalBusy(true);
    setEvalError(null);
    setEvalResult(null);
    try {
      const rel = model?.relationships.find((r) => r.id === evalRel);
      const result = await api<EvalResponse>(`/api/projects/${projectId}/model/evaluate`, {
        method: "POST",
        body: JSON.stringify({
          daxExpression: evalMeasure,
          relatedFilter:
            rel && evalDimValues.trim()
              ? {
                  relationshipId: rel.id,
                  values: evalDimValues
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                }
              : undefined,
          rowFilter:
            evalRowCol.trim() && evalRowValue.trim()
              ? {
                  column: evalRowCol,
                  values: evalRowValue
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                }
              : undefined,
        }),
      });
      setEvalResult(result);
    } catch (err) {
      setEvalError(errorMessage(err));
    } finally {
      setEvalBusy(false);
    }
  };

  if (error) return <ErrorMessage title="Could not load the model" message={error} onRetry={() => void load()} />;
  if (!model) return <div className="py-10 text-center text-sm text-muted">Loading model…</div>;

  const measureExpressions = model.measures.map((m) => m.daxExpression);
  const selectedDeps = lineageFor ? lineage.get(lineageFor) : undefined;

  const deleteMeasure = async (measure: ModelMeasure) => {
    const readers = measuresReading(lineage, { name: measure.name });
    const msg =
      readers.length > 0
        ? `Deleting "${measure.name}" breaks ${readers.length} measure(s) that use it: ${readers.join(", ")}. Delete anyway?`
        : `Delete measure "${measure.name}"? Nothing else depends on it.`;
    if (!window.confirm(msg)) return;
    try {
      await api(`/api/datasets/${measure.datasetId}/custom-metrics/${measure.id}`, { method: "DELETE" });
      toast({ title: "Measure deleted", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not delete measure", message: errorMessage(err), type: "error" });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Tables */}
      <section aria-label="Model tables">
        <h2 className="text-h2 text-foreground">Tables</h2>
        <p className="mt-1 text-sm text-muted">Each dataset in this project is a table in the model.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {model.tables.map((t) => (
            <Card key={t.datasetId} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-foreground">{t.name}</p>
                <Badge variant="default">{t.rowCount.toLocaleString()} rows</Badge>
              </div>
              <p className="mt-1 text-caption text-muted">{t.columns.length} column(s)</p>
              <ul className="mt-2 max-h-28 overflow-auto text-caption text-muted">
                {t.columns.slice(0, 12).map((c) => (
                  <li key={c.name} className="flex justify-between gap-2">
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 opacity-70">{c.type}</span>
                  </li>
                ))}
                {t.columns.length > 12 && <li className="opacity-70">+{t.columns.length - 12} more…</li>}
              </ul>
            </Card>
          ))}
          {model.tables.length === 0 && (
            <p className="text-sm text-muted">No datasets yet — upload one in the Datasets tab to start a model.</p>
          )}
        </div>
      </section>

      {/* Relationships */}
      <section aria-label="Model relationships">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-h2 text-foreground">Relationships</h2>
            <p className="mt-1 text-sm text-muted">
              Many-to-one joins between this project&apos;s datasets (many[table][key] → one[table][key]). Create them
              from a dataset&apos;s join flow; they are validated against the real rows here.
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {model.relationships.map((r) => {
            const relIssues = model.issues.filter((i) => i.relationship === r.id);
            const hasError = relIssues.some((i) => i.severity === "error");
            const hasWarning = relIssues.some((i) => i.severity === "warning");
            return (
              <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link2 aria-hidden className="size-4 text-accent" />
                  <span className="text-sm text-foreground">
                    <strong>{r.manyTable}</strong>[{r.manyColumn}] → <strong>{r.oneTable}</strong>[{r.oneColumn}]
                  </span>
                  {hasError ? (
                    <Badge variant="warning">broken</Badge>
                  ) : hasWarning ? (
                    <Badge variant="amber">warnings</Badge>
                  ) : (
                    <Badge variant="success">valid</Badge>
                  )}
                  {r.warnings.length > 0 && (
                    <span className="text-caption text-muted" title={r.warnings.join(" · ")}>
                      join warnings
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {relIssues.length > 0 && (
                    <span
                      className="max-w-md text-caption text-muted"
                      title={relIssues.map((i) => i.message).join("\n")}
                    >
                      {relIssues[0]!.message}
                    </span>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void deleteRelationship(r.id)}
                      icon={<Trash2 aria-hidden className="size-4" />}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
          {model.relationships.length === 0 && (
            <p className="rounded-md border border-line bg-surface-2/60 px-3 py-6 text-center text-sm text-muted">
              No relationships yet. Create a join between two datasets, then manage it here.
            </p>
          )}
        </div>
      </section>

      {/* Measures */}
      <section aria-label="Model measures">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-h2 text-foreground">Measures</h2>
            <p className="mt-1 text-sm text-muted">
              Reusable aggregations over model tables, evaluated with the DAX engine.
            </p>
          </div>
          {canEdit && model.tables.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCreateOpen(true)}
              icon={<Plus aria-hidden className="size-4" />}
            >
              New measure
            </Button>
          )}
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {model.measures.map((m) => (
            <Card key={m.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-foreground">{m.name}</p>
                <div className="flex items-center gap-1.5">
                  {m.datasetName && <Badge variant="info">{m.datasetName}</Badge>}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete measure ${m.name}`}
                      onClick={() => void deleteMeasure(m)}
                      icon={<Trash2 aria-hidden className="size-4" />}
                    />
                  )}
                </div>
              </div>
              <code className="mt-1 block text-caption text-accent">{m.daxExpression}</code>
              {m.description && <p className="mt-1 text-caption text-muted">{m.description}</p>}
              <button
                type="button"
                onClick={() => setLineageFor(lineageFor === m.name ? null : m.name)}
                className="mt-2 inline-flex items-center gap-1 text-caption text-muted transition-colors hover:text-foreground"
                aria-expanded={lineageFor === m.name}
              >
                <GitBranch aria-hidden className="size-3.5" />
                {lineageFor === m.name ? "Hide lineage" : "Show lineage"}
              </button>
              {lineageFor === m.name && selectedDeps && (
                <div className="mt-2 space-y-1.5 rounded-md border border-line bg-surface-2/60 p-2.5 text-caption">
                  <p>
                    <span className="font-semibold text-foreground">Reads columns:</span>{" "}
                    <span className="text-muted">
                      {selectedDeps.columns.length > 0
                        ? selectedDeps.columns
                            .map((c) =>
                              c.table ? `'${c.table}'[${c.name}]` : `[${c.name}]${c.ambiguous ? " (?)" : ""}`,
                            )
                            .join(", ")
                        : "none"}
                    </span>
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">Calls measures:</span>{" "}
                    <span className="text-muted">
                      {selectedDeps.measures.length > 0 ? selectedDeps.measures.join(", ") : "none"}
                    </span>
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">Tables touched:</span>{" "}
                    <span className="text-muted">
                      {selectedDeps.tables.length > 0 ? selectedDeps.tables.join(", ") : "none"}
                    </span>
                  </p>
                  <p>
                    <span className="font-semibold text-foreground">Depended on by:</span>{" "}
                    <span className="text-muted">
                      {(() => {
                        const readers = measuresReading(lineage, { name: m.name }).filter((r) => r !== m.name);
                        return readers.length > 0 ? readers.join(", ") : "no other measures";
                      })()}
                    </span>
                  </p>
                </div>
              )}
            </Card>
          ))}
          {model.measures.length === 0 && (
            <p className="text-sm text-muted">
              No measures yet — create one to reuse it across analyses and dashboards.
            </p>
          )}
        </div>
      </section>

      {/* Evaluate */}
      <section aria-label="Evaluate a measure">
        <h2 className="text-h2 text-foreground">Evaluate</h2>
        <p className="mt-1 text-sm text-muted">
          Run a measure against the model with optional RELATED() and row filters. The applied filters are shown with
          the result.
        </p>
        <Card className="mt-3 flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-caption text-muted">
              Measure
              <select
                value={evalMeasure}
                onChange={(e) => setEvalMeasure(e.target.value)}
                className="h-9 w-56 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
              >
                <option value="">Choose a measure…</option>
                {model.measures.map((m) => (
                  <option key={m.id} value={m.daxExpression}>
                    {m.name} ({m.daxExpression})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-caption text-muted">
              RELATED filter (optional)
              <select
                value={evalRel}
                onChange={(e) => {
                  setEvalRel(e.target.value);
                  setEvalDimValues("");
                }}
                className="h-9 w-64 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
                disabled={!evalMeasure}
              >
                <option value="">No dimension filter</option>
                {model.relationships.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.oneTable}[{r.oneColumn}]
                  </option>
                ))}
              </select>
            </label>
            {evalRel && (
              <label className="flex flex-col gap-1 text-caption text-muted">
                Values (comma-separated)
                <input
                  value={evalDimValues}
                  onChange={(e) => setEvalDimValues(e.target.value)}
                  placeholder="VIP, Basic"
                  className="h-9 w-44 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
                />
              </label>
            )}
            <label className="flex flex-col gap-1 text-caption text-muted">
              Row-filter column (optional)
              <select
                value={evalRowCol}
                onChange={(e) => setEvalRowCol(e.target.value)}
                className="h-9 w-44 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
                disabled={!evalMeasure}
              >
                <option value="">No row filter</option>
                {rowColumnCandidates.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {evalRowCol && (
              <label className="flex flex-col gap-1 text-caption text-muted">
                Values (comma-separated)
                <input
                  value={evalRowValue}
                  onChange={(e) => setEvalRowValue(e.target.value)}
                  className="h-9 w-44 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
                />
              </label>
            )}
            <Button
              size="sm"
              onClick={() => void evaluate()}
              loading={evalBusy}
              disabled={!evalMeasure}
              icon={<Play aria-hidden className="size-4" />}
            >
              Run
            </Button>
          </div>

          {evalError && <ErrorMessage title="Evaluation failed" message={evalError} />}
          {evalResult && (
            <div className="rounded-md border border-line bg-surface-2/60 p-3">
              <p className="text-h1 text-foreground">
                {evalResult.value === null
                  ? "—"
                  : evalResult.value.toLocaleString("en-US", { maximumFractionDigits: 4 })}
              </p>
              <p className="mt-1 text-caption text-muted">
                Computed from {evalResult.rowsUsed.toLocaleString()} rows. Applied:{" "}
                {evalResult.applied.length > 0 ? evalResult.applied.join(" · ") : "no filters (full model)"}.
              </p>
            </div>
          )}
          {measureExpressions.length === 0 && (
            <p className="text-caption text-muted">
              Create a measure first — evaluation runs one of the listed measures.
            </p>
          )}
        </Card>
      </section>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="New measure" size="md">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-caption text-muted">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Total revenue"
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted">
            Description (optional)
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted">
            Table (dataset)
            <select
              value={measureTable}
              onChange={(e) => {
                setMeasureTable(e.target.value);
                setColumn("");
              }}
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose…</option>
              {model.tables.map((t) => (
                <option key={t.datasetId} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-caption text-muted">
              Aggregation
              <select
                value={aggregation}
                onChange={(e) => setAggregation(e.target.value as (typeof AGGREGATIONS)[number])}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
              >
                {AGGREGATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-caption text-muted">
              Column
              <select
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
                disabled={!chosenTable}
              >
                <option value="">Choose…</option>
                {numericColumns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-caption text-muted">
            Expression preview: <code className="text-accent">{`${aggregation}([${column || "column"}])`}</code>
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createMeasure()} loading={busy} icon={<Plus aria-hidden className="size-4" />}>
              Create measure
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
