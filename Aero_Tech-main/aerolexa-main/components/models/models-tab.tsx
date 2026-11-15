"use client";

import { BrainCircuit, Download, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface GeneralizationInfo {
  primaryMetric: string;
  train: number;
  validation: number;
  test: number;
  gap: number;
  risk: "low" | "medium" | "high";
  explanation: string;
}

export interface ModelRow {
  id: string;
  name: string;
  task: string;
  version: number;
  status: string;
  datasetName: string | null;
  createdAt: string;
  headline: string;
  isReal: boolean;
  /** false for unsupervised clustering (no held-out accuracy exists) */
  heldOut?: boolean;
  generalization?: GeneralizationInfo | null;
  /** Design-matrix feature names from the model card (drives the serving form). */
  features?: string[];
}
export interface TrainDatasetOption {
  id: string;
  name: string;
  isDemo: boolean;
  columns: { name: string; type: string }[];
}

const TASKS = [
  { value: "regression", label: "Regression", hint: "Predict a number (e.g. revenue)" },
  { value: "classification", label: "Classification", hint: "Predict a yes/no label" },
  { value: "clustering", label: "Clustering", hint: "Group rows without a target" },
] as const;

const ALGORITHMS = [
  { value: "linear-regression", label: "Linear regression" },
  { value: "logistic-regression", label: "Logistic regression" },
  { value: "random-forest", label: "Random forest" },
  { value: "gradient-boosting", label: "Gradient boosting" },
  { value: "mlp", label: "Neural network (MLP)" },
  { value: "k-means", label: "K-means" },
] as const;

export function ModelsTab({ projectId, datasets }: { projectId: string; datasets: TrainDatasetOption[] }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [dataset, setDataset] = useState("");
  const [task, setTask] = useState<string>("regression");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [algorithm, setAlgorithm] = useState("linear-regression");
  const [testRatio, setTestRatio] = useState(0.2);
  const [cvFolds, setCvFolds] = useState(5);
  const [engine, setEngine] = useState<"standard" | "advanced">("advanced");
  const [serving, setServing] = useState<ServingTarget | null>(null);
  /** Live training progress (advanced engine only) — fed by the SSE stream. */
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const progressSourceRef = useRef<EventSource | null>(null);

  useEffect(
    () => () => {
      // Unmount cleanup: never leak a live SSE subscription.
      progressSourceRef.current?.close();
      progressSourceRef.current = null;
    },
    [],
  );

  const chosen = datasets.find((d) => d.id === dataset);
  // Target candidates: numeric columns for regression, two-value style
  // (string/boolean) columns for classification.
  const targetCandidates = chosen
    ? task === "clustering"
      ? []
      : task === "regression"
        ? chosen.columns.filter((c) => c.type === "number" || c.type === "boolean")
        : chosen.columns.filter((c) => c.type === "string" || c.type === "boolean")
    : [];

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ models: ModelRow[] }>(`/api/projects/${projectId}/models`);
      setModels(data.models);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const train = async () => {
    if (!dataset) {
      setFormError("Choose a dataset.");
      return;
    }
    setBusy(true);
    setFormError(null);
    // Live progress (advanced engine): generate an unguessable run id, open
    // the SSE stream BEFORE the POST (no event missed), render phase + %
    // while the worker trains. The POST response stays the source of truth.
    const runId =
      task !== "clustering" && engine === "advanced"
        ? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        : null;
    if (runId) {
      const source = new EventSource(`/api/training/progress?runId=${runId}`);
      progressSourceRef.current = source;
      source.addEventListener("progress", (e) => {
        try {
          setProgress(JSON.parse((e as MessageEvent).data) as { phase: string; done: number; total: number });
        } catch {
          /* a malformed frame never breaks the fit */
        }
      });
      const stop = (): void => {
        source.close();
        if (progressSourceRef.current === source) progressSourceRef.current = null;
        setProgress(null);
      };
      source.addEventListener("done", stop);
      source.addEventListener("error", stop);
    }
    try {
      const data = await api<{
        model: {
          id: string;
          name: string;
          task: string;
          version: number;
          metrics?: { generalization?: GeneralizationInfo };
        };
      }>("/api/training", {
        method: "POST",
        body: JSON.stringify({
          datasetId: dataset,
          projectId,
          task,
          name,
          targetColumn: task === "clustering" ? null : target || null,
          algorithm: task === "clustering" ? "k-means" : algorithm,
          testRatio: task === "clustering" ? undefined : testRatio,
          cvFolds: task === "clustering" ? undefined : cvFolds,
          engine: task === "clustering" ? "standard" : engine,
          hyperparams: runId ? { runId } : undefined,
        }),
      });
      // Actively warn at training time, not just on a detail page — a
      // non-technical user should not walk away thinking a memorized model is good.
      const risk = data.model.metrics?.generalization?.risk;
      if (risk === "high") {
        toast({
          title: "Model trained — overfitting risk is high",
          message: `${data.model.metrics?.generalization?.explanation ?? ""} Held-out metrics are shown on the model card.`,
          type: "error",
        });
      } else {
        toast({
          title: "Model trained",
          message: `“${data.model.name}” v${data.model.version} is ready (held-out metrics on the model card).`,
          type: "success",
        });
      }
      setOpen(false);
      setName("");
      setTarget("");
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      progressSourceRef.current?.close();
      progressSourceRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  };

  const remove = async (row: ModelRow) => {
    const ok = await confirm({
      title: `Delete model “${row.name}” v${row.version}?`,
      message: "The trained weights and model card for this version will be removed.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/models/${row.id}`, { method: "DELETE" });
      toast({ title: "Model deleted", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not delete model", message: errorMessage(err), type: "error" });
    }
  };

  if (!models) return <LoadingSkeleton rows={3} />;

  return (
    <div>
      {error && (
        <ErrorMessage title="Could not load models" message={error} onRetry={() => void load()} className="mb-4" />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setOpen(true)}
          disabled={datasets.length === 0}
          icon={<Plus aria-hidden className="size-4" />}
        >
          Train a model
        </Button>
        {datasets.length === 0 && <span className="text-caption text-muted">Upload a dataset first.</span>}
        <div className="flex-1" />
        {models.some((model) => !model.isReal) && (
          <DemoBadge tooltip="Some older models were trained before the current engine. All newly trained models use the real statistical engine with held-out metrics and diagnostics." />
        )}
      </div>

      {models.length === 0 ? (
        <Card>
          <EmptyState
            icon={BrainCircuit}
            title="No trained models"
            description="Train a deterministic model on one of this project's datasets — regression, binary classification or k-means clustering. Supervised models are evaluated on a held-out split and download as a model-card JSON."
            action={
              datasets.length ? (
                <Button onClick={() => setOpen(true)} icon={<Plus aria-hidden className="size-4" />}>
                  Train your first model
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {models.map((m) => (
            <li key={m.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 items-center justify-center rounded-md bg-accent/12 text-accent"
                  >
                    <BrainCircuit className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                      {m.name} <Badge variant="accent">v{m.version}</Badge>
                      {m.heldOut && <Badge variant="outline">held-out metric</Badge>}
                      {m.generalization?.risk === "high" && <Badge variant="critical">overfitting risk</Badge>}
                      {m.generalization?.risk === "medium" && <Badge variant="warning">generalization gap</Badge>}
                    </p>
                    <p className="text-caption text-muted">
                      {m.task} · {m.headline} · {m.datasetName ?? "dataset"} · {timeAgo(m.createdAt)}
                    </p>
                  </div>
                  {m.isReal && m.task !== "clustering" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Play aria-hidden className="size-4" />}
                      onClick={() => setServing({ model: m, mode: "predict" })}
                    >
                      Predict
                    </Button>
                  )}
                  <a href={`/api/models/${m.id}/download`} download>
                    <Button variant="secondary" size="sm" icon={<Download aria-hidden className="size-4" />}>
                      Download
                    </Button>
                  </a>
                  <Button variant="ghost" size="sm" aria-label="Delete model" onClick={() => void remove(m)}>
                    <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
                  </Button>
                </div>
                {m.generalization && m.generalization.risk !== "low" && (
                  <div
                    className={cn(
                      "mt-3 rounded-md border px-3 py-2 text-caption",
                      m.generalization.risk === "high"
                        ? "border-danger/40 bg-danger/10 text-foreground"
                        : "border-warning/40 bg-warning/10 text-foreground",
                    )}
                  >
                    <span className="font-medium">
                      {m.generalization.risk === "high" ? "Overfitting risk: high. " : "Generalization gap. "}
                    </span>
                    {m.generalization.explanation}
                  </div>
                )}
                {m.heldOut && m.generalization && m.generalization.risk === "low" && (
                  <p className="mt-2 text-caption text-muted">
                    Held-out {m.generalization.primaryMetric} {m.generalization.test} (train {m.generalization.train},
                    validation {m.generalization.validation}) — training and unseen rows agree.
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Train a model"
        description="Configure a real statistical model and evaluate it on held-out data."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void train()} loading={busy} icon={<BrainCircuit aria-hidden className="size-4" />}>
              Train model
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <ErrorMessage title="Could not train" message={formError} />}
          {busy && progress && (
            <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
              <div className="mb-1 flex items-center justify-between text-caption text-muted">
                <span>
                  {progress.phase === "cv"
                    ? "Cross-validating"
                    : progress.phase === "refit"
                      ? "Refitting on all rows"
                      : "Computing permutation importance"}
                </span>
                <span>
                  {progress.done}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Dataset</span>
            <select
              value={dataset}
              onChange={(e) => {
                setDataset(e.target.value);
                setTarget("");
              }}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.isDemo ? "demo" : "uploaded"})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Algorithm</span>
            <select
              value={task === "clustering" ? "k-means" : algorithm}
              disabled={task === "clustering"}
              onChange={(e) => setAlgorithm(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {ALGORITHMS.filter((item) =>
                task === "clustering"
                  ? item.value === "k-means"
                  : task === "classification"
                    ? item.value !== "linear-regression" && item.value !== "k-means"
                    : item.value !== "logistic-regression" && item.value !== "k-means",
              ).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {task !== "clustering" && (
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium text-foreground">Validation engine</span>
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as "standard" | "advanced")}
                className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
              >
                <option value="standard">Standard — train/validation/test hold-out</option>
                <option value="advanced">Advanced — k-fold CV, out-of-fold metrics, permutation importance</option>
              </select>
              <span className="mt-1 block text-caption text-muted">
                {engine === "advanced"
                  ? "Every row is held out exactly once across the folds; the CV metric is the honest generalization estimate. Slower on big datasets."
                  : "Fast single split; the model card shows train vs validation vs test with an overfitting guard."}
              </span>
            </label>
          )}
          {task !== "clustering" && engine === "advanced" && (
            <p className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-caption text-muted">
              Advanced engine maps: linear → ridge, logistic → logistic (IRLS), random forest → forest, gradient
              boosting → Friedman boosting, neural network → 2×ReLU MLP (AdamW, cosine schedule). Clustering is not
              available in the advanced engine.
            </p>
          )}
          {task !== "clustering" && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-foreground">
                  Test ratio{engine === "advanced" ? " (unused by CV)" : ""}
                </span>
                <input
                  type="number"
                  min={0.1}
                  max={0.49}
                  step={0.05}
                  value={testRatio}
                  onChange={(e) => setTestRatio(Number(e.target.value))}
                  disabled={engine === "advanced"}
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm disabled:opacity-50"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-foreground">CV folds</span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  value={cvFolds}
                  onChange={(e) => setCvFolds(Number(e.target.value))}
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm"
                />
              </label>
            </div>
          )}
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Task</span>
            <select
              value={task}
              onChange={(e) => {
                const nextTask = e.target.value;
                setTask(nextTask);
                setAlgorithm(
                  nextTask === "classification"
                    ? "logistic-regression"
                    : nextTask === "clustering"
                      ? "k-means"
                      : "linear-regression",
                );
              }}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              {TASKS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">
              Target column {task === "clustering" ? "(not needed)" : "(required)"}
            </span>
            <select
              value={target}
              disabled={task === "clustering" || targetCandidates.length === 0}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="">Choose…</option>
              {targetCandidates.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
            {task !== "clustering" && targetCandidates.length === 0 && (
              <span className="mt-1 block text-caption text-muted">
                No candidate columns — classification needs a two-value (e.g. yes/no) column; regression needs numeric
                data.
              </span>
            )}
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Model name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${datasets.find((d) => d.id === dataset)?.name ?? "Dataset"} · ${task}`}
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <p className="text-caption text-muted">
            Tip: open the dataset first to check column names and cast string numbers to Number.
          </p>
        </div>
      </Dialog>
      {serving && <ServingDialog model={serving.model} mode={serving.mode} onClose={() => setServing(null)} />}
    </div>
  );
}

/** Serving dialog state: which model and which panel. */
type ServingTarget = { model: ModelRow; mode: "predict" | "explain" };

/** Payload types — the api() helper unwraps the { ok, data } envelope. */
interface ServeResult {
  output: number | string;
  probabilities?: { label: string; probability: number }[];
  methodology: string;
}

interface ExplainResult {
  prediction: number | string;
  baseValue: number;
  contributions: { feature: string; phi: number }[];
  reconstructionError: number;
  methodology: string;
}

/**
 * Model serving + explanation UI — the browser face of /predict and /explain.
 * Builds a form from the model's feature list, POSTs the raw values, and
 * renders the prediction (with class probabilities) or the ranked Shapley
 * attributions with the additive-guarantee provenance line.
 */
function ServingDialog({
  model,
  mode,
  onClose,
}: {
  model: ModelRow;
  mode: "predict" | "explain";
  onClose: () => void;
}) {
  const [features, setFeatures] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ServeResult | ExplainResult | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    const parsed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(features)) {
      if (v === "") continue;
      const n = Number(v.replace(/[,$\s%]/g, ""));
      parsed[k] = Number.isFinite(n) && v.trim() !== "" ? n : v;
    }
    try {
      if (mode === "predict") {
        // api<T> unwraps the { ok, data } envelope — T IS the payload.
        const payload = await api<ServeResult>(`/api/models/${model.id}/predict`, {
          method: "POST",
          body: JSON.stringify({ features: parsed }),
        });
        setResult(payload ?? null);
      } else {
        const payload = await api<ExplainResult>(`/api/models/${model.id}/explain`, {
          method: "POST",
          body: JSON.stringify({ features: parsed, nPermutations: 24 }),
        });
        setResult(payload ?? null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const isExplain = mode === "explain";
  const explain = isExplain ? (result as ExplainResult | null) : null;
  const served = !isExplain ? (result as ServeResult | null) : null;
  const maxAbsPhi = explain ? Math.max(...explain.contributions.map((c) => Math.abs(c.phi)), 1e-12) : 1;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${isExplain ? "Explain" : "Predict"} — ${model.name} v${model.version}`}
      description={
        isExplain
          ? "Permutation-Shapley attributions for one row — every feature's additive contribution to THIS prediction."
          : "Serve the trained model: values go through the same train-fitted preprocessing as training."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void run()}
            loading={busy}
            icon={isExplain ? <Sparkles aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
          >
            {isExplain ? "Explain row" : "Predict"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorMessage title="Could not run" message={error} />}
        {(model.features ?? []).map((f) => (
          <label key={f} className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">{f}</span>
            <input
              value={features[f] ?? ""}
              onChange={(e) => setFeatures((prev) => ({ ...prev, [f]: e.target.value }))}
              placeholder="value"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
        ))}
        {(model.features ?? []).length === 0 && (
          <p className="text-caption text-muted">
            This model card does not expose its feature list — re-train to enable serving.
          </p>
        )}

        {served && (
          <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
            <p className="text-caption text-muted">Prediction</p>
            <p className="text-lg font-semibold text-foreground">
              {typeof served.output === "number"
                ? served.output.toLocaleString(undefined, { maximumFractionDigits: 4 })
                : served.output}
            </p>
            {served.probabilities && served.probabilities.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {served.probabilities.map((p) => (
                  <div key={p.label} className="flex items-center gap-2">
                    <span className="w-24 truncate text-caption text-muted">{p.label}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.round(p.probability * 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-caption text-muted">{(p.probability * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {explain && (
          <div className="flex flex-col gap-2">
            <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
              <p className="text-caption text-muted">Prediction being explained</p>
              <p className="text-lg font-semibold text-foreground">
                {typeof explain.prediction === "number"
                  ? explain.prediction.toLocaleString(undefined, { maximumFractionDigits: 4 })
                  : explain.prediction}
              </p>
              <p className="mt-1 text-caption text-muted">
                Base value (expected over background): {explain.baseValue.toFixed(4)}
              </p>
            </div>
            {explain.contributions.map((c) => (
              <div key={c.feature} className="flex items-center gap-2">
                <span className="w-32 truncate text-caption text-muted" title={c.feature}>
                  {c.feature}
                </span>
                <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-line">
                  <div className="flex h-full">
                    {c.phi >= 0 ? (
                      <>
                        <span className="h-full" style={{ width: "50%" }} />
                        <span
                          className="h-full bg-accent"
                          style={{ width: `${(Math.abs(c.phi) / maxAbsPhi) * 50}%` }}
                        />
                      </>
                    ) : (
                      <>
                        <span
                          className="h-full bg-danger"
                          style={{ width: `${(Math.abs(c.phi) / maxAbsPhi) * 50}%` }}
                        />
                        <span className="h-full" style={{ width: `${50 - (Math.abs(c.phi) / maxAbsPhi) * 50}%` }} />
                      </>
                    )}
                  </div>
                </div>
                <span className="w-16 text-right text-caption text-muted">{c.phi.toFixed(3)}</span>
              </div>
            ))}
            <p className="text-caption text-muted">
              Reconstruction error: {explain.reconstructionError.toExponential(2)} (≈ 0 proves the attributions add up).
            </p>
          </div>
        )}

        {result && "methodology" in result && result.methodology && (
          <p className="text-caption text-muted">{result.methodology}</p>
        )}
      </div>
    </Dialog>
  );
}
