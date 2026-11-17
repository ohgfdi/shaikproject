"use client";

import { ArrowLeft, ArrowRight, FlaskConical, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Input, Select, Field, Checkbox } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Card, Badge } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { trustLabelForKind } from "@/lib/trust/labels";
import {
  ANALYSIS_KIND_LABELS,
  ANALYSIS_KIND_DESCRIPTIONS,
  type AnalysisKind,
  type ColType,
  type Granularity,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface WizardColumn {
  name: string;
  type: ColType;
}

export interface WizardDataset {
  id: string;
  name: string;
  rowCount: number;
  isDemo: boolean;
  columns: WizardColumn[];
}

const KINDS: AnalysisKind[] = [
  "eda",
  "kpi",
  "trend",
  "correlation",
  "distribution",
  "forecast",
  "variance",
  "segmentation",
  "cohort",
  "funnel",
  "whatif",
  "regression",
  "abtest",
  "automl",
  "arimax",
  "dataquality",
  "accounting",
  "syntheticcontrol",
  "uplift",
  "sprt",
  "drift",
  "compliance",
  "nlp",
  "deep-learning",
];

export function AnalysisWizard({
  projectId: _projectId,
  datasets,
  initialDatasetId,
}: {
  projectId: string;
  datasets: WizardDataset[];
  initialDatasetId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(initialDatasetId ? 1 : 0);
  const [datasetId, setDatasetId] = useState(initialDatasetId ?? datasets[0]?.id ?? "");
  const [kind, setKind] = useState<AnalysisKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const dataset = datasets.find((d) => d.id === datasetId);
  const columns = useMemo(() => dataset?.columns ?? [], [dataset]);
  const numCols = useMemo(() => columns.filter((c) => c.type === "number"), [columns]);
  const dateCols = useMemo(() => columns.filter((c) => c.type === "date"), [columns]);
  const strCols = useMemo(() => columns.filter((c) => c.type === "string"), [columns]);

  const [metric, setMetric] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [dimensionCol, setDimensionCol] = useState("");
  const [entityCol, setEntityCol] = useState("");
  const [stageCol, setStageCol] = useState("");
  const [multiCols, setMultiCols] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [horizon, setHorizon] = useState(4);
  const [bins, setBins] = useState(0);
  const [k, setK] = useState(3);
  const [filterCol, setFilterCol] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [title, setTitle] = useState("");
  // Advanced-kind controls (regression / abtest / automl / arimax).
  const [groupCol, setGroupCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [successesCol, setSuccessesCol] = useState("");
  const [trialsCol, setTrialsCol] = useState("");
  const [armCol, setArmCol] = useState("");
  const [targetCol, setTargetCol] = useState("");
  const [task, setTask] = useState<"regression" | "binary-classification" | "multiclass-classification">("regression");
  const [cvFolds, setCvFolds] = useState(5);
  const [regressors, setRegressors] = useState<string[]>([]);
  const [testKind, setTestKind] = useState<"welch" | "student" | "mann-whitney">("welch");
  const [uniqueCol, setUniqueCol] = useState("");
  const [inSetCol, setInSetCol] = useState("");
  const [allowedValues, setAllowedValues] = useState("");
  const [rangeCol, setRangeCol] = useState("");
  const [dqMin, setDqMin] = useState("");
  const [dqMax, setDqMax] = useState("");
  const [dqSeverity, setDqSeverity] = useState<"error" | "warn">("error");
  const [accountCol, setAccountCol] = useState("");
  const [debitCol, setDebitCol] = useState("");
  const [creditCol, setCreditCol] = useState("");
  const [referenceCol, setReferenceCol] = useState("");
  const [unitCol, setUnitCol] = useState("");
  const [treatedValue, setTreatedValue] = useState("");
  const [prePeriods, setPrePeriods] = useState(6);
  const [treatmentCol, setTreatmentCol] = useState("");
  const [outcomeCol, setOutcomeCol] = useState("");
  const [upliftTask, setUpliftTask] = useState<"binary" | "regression">("binary");
  const [upliftLearner, setUpliftLearner] = useState<"t-learner" | "s-learner">("t-learner");
  const [upliftFolds, setUpliftFolds] = useState(4);
  const [mdeRelative, setMdeRelative] = useState(5);
  const [referenceSplit, setReferenceSplit] = useState(50);
  const [kindCol, setKindCol] = useState("");
  const [rateCol, setRateCol] = useState("");
  const [taxableCol, setTaxableCol] = useState("");
  const [sectionCol, setSectionCol] = useState("");
  const [panCol, setPanCol] = useState("");
  const [gstinCol, setGstinCol] = useState("");
  const [openingCredit, setOpeningCredit] = useState(0);
  const [auditSampleSize, setAuditSampleSize] = useState(25);
  const [period, setPeriod] = useState("");

  const kindRequires = (k: AnalysisKind): { numeric: boolean; date: boolean; string: boolean } => {
    switch (k) {
      case "trend":
      case "forecast":
        return { numeric: true, date: true, string: false };
      case "kpi":
        return { numeric: true, date: false, string: false };
      case "correlation":
        return { numeric: true, date: false, string: false };
      case "distribution":
        return { numeric: true, date: false, string: false };
      case "variance":
        return { numeric: true, date: false, string: false };
      case "segmentation":
        return { numeric: true, date: false, string: false };
      case "cohort":
        return { numeric: false, date: true, string: true };
      case "funnel":
        return { numeric: false, date: false, string: true };
      case "regression":
        return { numeric: true, date: false, string: true };
      case "abtest":
        return { numeric: true, date: false, string: true };
      case "automl":
        return { numeric: true, date: false, string: false };
      case "arimax":
        return { numeric: true, date: true, string: false };
      case "dataquality":
        return { numeric: false, date: false, string: true };
      case "accounting":
        return { numeric: true, date: true, string: true };
      case "syntheticcontrol":
        return { numeric: true, date: true, string: true };
      case "uplift":
        return { numeric: true, date: false, string: false };
      case "sprt":
        return { numeric: true, date: false, string: true };
      case "drift":
        return { numeric: false, date: false, string: false };
      case "compliance":
        return { numeric: true, date: false, string: true };
      case "nlp":
        return { numeric: false, date: false, string: true };
      case "deep-learning":
        return { numeric: true, date: false, string: false };
      default:
        return { numeric: false, date: false, string: false };
    }
  };

  const canContinueToParams = (k: AnalysisKind) => {
    const req = kindRequires(k);
    if (req.numeric && numCols.length === 0) return false;
    if (req.date && dateCols.length === 0) return false;
    if (req.string && strCols.length === 0) return false;
    return true;
  };

  const defaultsFor = (_k: AnalysisKind) => {
    setMetric(numCols[0]?.name ?? "");
    setDateCol(dateCols[0]?.name ?? "");
    setDimensionCol(strCols[0]?.name ?? "");
    setEntityCol(strCols[0]?.name ?? "");
    setStageCol(strCols[0]?.name ?? "");
    setMultiCols(numCols.slice(0, 3).map((c) => c.name));
    // Advanced-kind defaults. Group/arm columns default to the first string
    // column and the value/target columns to the first numeric ones, so the
    // form is submittable immediately; the user can re-point them.
    setGroupCol(strCols[0]?.name ?? "");
    setArmCol(strCols[0]?.name ?? "");
    setValueCol(numCols[0]?.name ?? "");
    setSuccessesCol(numCols[0]?.name ?? "");
    setTrialsCol(numCols[1]?.name ?? numCols[0]?.name ?? "");
    setTargetCol(numCols[0]?.name ?? "");
    setRegressors(numCols.length > 1 && numCols[1] ? [numCols[1].name] : []);
    setUniqueCol(numCols[0]?.name ?? "");
    setInSetCol(strCols[0]?.name ?? "");
    setRangeCol(numCols[0]?.name ?? "");
    setAccountCol(strCols[0]?.name ?? "");
    setDebitCol(numCols[0]?.name ?? "");
    setCreditCol(numCols[1]?.name ?? numCols[0]?.name ?? "");
    setReferenceCol("");
    setUnitCol(strCols[0]?.name ?? "");
    setTreatedValue(strCols[0]?.name ?? "");
    setTreatmentCol(strCols[0]?.name ?? numCols[0]?.name ?? "");
    setOutcomeCol(numCols[0]?.name ?? "");
    setKindCol(strCols[0]?.name ?? "");
    setRateCol(numCols[0]?.name ?? "");
    setTaxableCol(numCols[1]?.name ?? numCols[0]?.name ?? "");
    setSectionCol("");
    setPanCol("");
    setGstinCol("");
    setTitle("");
  };

  const run = async () => {
    if (!dataset || !kind) return;
    setError(null);
    setRunning(true);
    const config: Record<string, unknown> = {};
    const req = kindRequires(kind);
    if (req.numeric) config.metric = metric;
    if (req.date) config.dateCol = dateCol;
    if (["trend", "forecast", "kpi"].includes(kind)) config.granularity = granularity;
    if (kind === "forecast") config.horizon = horizon;
    if (kind === "kpi") {
      config.dateCol = dateCol || null;
      config.dimensionCol = dimensionCol || null;
    }
    if (kind === "correlation") config.columns = multiCols.length ? multiCols : numCols.slice(0, 6).map((c) => c.name);
    if (kind === "distribution") {
      config.column = metric;
      config.bins = bins;
    }
    if (kind === "variance") {
      config.dimensionCol = dimensionCol || null;
      config.dateCol = dateCol || null;
    }
    if (kind === "segmentation") {
      config.columns = multiCols.length ? multiCols : numCols.slice(0, 4).map((c) => c.name);
      config.k = k;
    }
    if (kind === "cohort") {
      config.entityCol = entityCol;
    }
    if (kind === "funnel") {
      config.stageCol = stageCol;
    }
    if (kind === "whatif") {
      config.driverColumn = metric;
      config.outcomeColumn = dateCol;
      config.pctChange = horizon;
    }
    if (kind === "regression") {
      config.groupCol = groupCol;
      config.valueCol = valueCol || metric;
      config.test = testKind;
      config.adjust = false;
      config.alpha = 0.05;
    }
    if (kind === "abtest") {
      config.successesCol = successesCol || metric;
      config.trialsCol = trialsCol || numCols[1]?.name || "";
      config.armCol = armCol;
      config.valueCol = null;
      config.alpha = 0.05;
      config.power = 0.8;
    }
    if (kind === "automl") {
      config.targetColumn = targetCol || metric;
      config.featureColumns = multiCols.length ? multiCols : numCols.slice(0, 4).map((c) => c.name);
      config.task = task;
      config.cvFolds = cvFolds;
      config.maxCandidates = 12;
    }
    if (kind === "arimax") {
      config.dateCol = dateCol;
      config.metric = metric;
      config.granularity = granularity;
      config.horizon = horizon;
      config.regressors = regressors.length ? regressors : [numCols[1]?.name || metric];
      config.level = 0.95;
    }
    if (kind === "dataquality") {
      config.requiredCol = strCols[0]?.name || metric;
      config.uniqueCol = uniqueCol || null;
      config.inSetCol = inSetCol || null;
      config.allowedValues = allowedValues
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      config.rangeCol = rangeCol || null;
      config.min = dqMin === "" ? null : Number(dqMin);
      config.max = dqMax === "" ? null : Number(dqMax);
      config.severity = dqSeverity;
    }
    if (kind === "accounting") {
      config.dateCol = dateCol;
      config.accountCol = accountCol;
      config.debitCol = debitCol;
      config.creditCol = creditCol;
      config.narrationCol = null;
      config.referenceCol = referenceCol || null;
      config.from = null;
      config.to = null;
    }
    if (kind === "syntheticcontrol") {
      config.dateCol = dateCol;
      config.unitCol = unitCol || strCols[0]?.name || "";
      config.metric = metric;
      config.granularity = granularity;
      config.treatedValue = treatedValue;
      config.prePeriods = prePeriods;
      config.maxIter = 1000;
    }
    if (kind === "uplift") {
      config.features = multiCols.length ? multiCols : numCols.slice(0, 5).map((c) => c.name);
      config.treatmentCol = treatmentCol;
      config.outcomeCol = outcomeCol || metric;
      config.task = upliftTask;
      config.learner = upliftLearner;
      config.folds = upliftFolds;
    }
    if (kind === "sprt") {
      config.successesCol = successesCol || metric;
      config.trialsCol = trialsCol || numCols[1]?.name || "";
      config.armCol = armCol;
      config.mdeRelative = mdeRelative / 100;
      config.alpha = 0.05;
      config.beta = 0.2;
    }
    if (kind === "drift") {
      config.dateCol = dateCol || null;
      config.granularity = granularity;
      config.referenceSplit = referenceSplit / 100;
      config.columns = multiCols;
    }
    if (kind === "compliance") {
      config.period = period || "current";
      config.kindCol = kindCol;
      config.rateCol = rateCol;
      config.taxableCol = taxableCol;
      config.reverseChargeCol = null;
      config.sectionCol = sectionCol || null;
      config.panCol = panCol || null;
      config.gstinCol = gstinCol || null;
      config.openingCredit = openingCredit;
      config.auditSampleSize = auditSampleSize;
    }
    if (kind === "nlp") {
      // Defaults are honest and submittable in one click: the first text column
      // is the corpus and the similarity task reports the learned-vector
      // retrieval block (word2vec) alongside the TF-IDF near-duplicate scan.
      config.textCol = strCols[0]?.name || metric;
      config.task = "similarity";
      config.labelCol = null;
      config.numTopics = 5;
      config.topK = 10;
      config.minDf = 1;
      config.sampleSize = 500;
    }
    if (kind === "deep-learning") {
      config.target = targetCol || metric;
      config.features = multiCols.filter((c) => c !== (targetCol || metric));
      config.task = "regression";
      config.architecture = "mlp";
      config.workers = 2;
      config.hidden = 16;
      config.epochs = 20;
      config.learningRate = 0.01;
      config.batchSize = 16;
      config.depth = 3;
      config.patience = 5;
      config.device = "cpu";
    }
    if (req.string && kind === "variance") config.dimensionCol = dimensionCol || null;
    if (filterCol && filterValue) {
      config.filterCol = filterCol;
      config.filterValue = filterValue;
    }

    try {
      const res = await api<{ analysis: { id: string } }>(`/api/datasets/${dataset.id}/analyses`, {
        method: "POST",
        body: JSON.stringify({ kind, title: title.trim() || undefined, config }),
      });
      toast({ title: "Analysis completed", type: "success" });
      router.push(`/analyses/${res.analysis.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const canRun = (() => {
    if (!kind) return false;
    const req = kindRequires(kind);
    if (req.numeric && !metric) return false;
    if (req.date && !dateCol) return false;
    if (kind === "cohort" && !entityCol) return false;
    if (kind === "funnel" && !stageCol) return false;
    if (kind === "whatif" && (!metric || !dateCol)) return false;
    if (kind === "regression" && (!groupCol || !(valueCol || metric))) return false;
    if (kind === "abtest" && (!armCol || !(successesCol || metric) || !trialsCol)) return false;
    if (kind === "automl" && !(targetCol || metric)) return false;
    if (kind === "arimax" && (!metric || !dateCol || regressors.length === 0)) return false;
    if (kind === "dataquality" && !strCols[0]) return false;
    if (kind === "accounting" && (!dateCol || !accountCol || !debitCol || !creditCol)) return false;
    if (kind === "syntheticcontrol" && (!dateCol || !metric || !unitCol || !treatedValue)) return false;
    if (kind === "uplift" && (!treatmentCol || !(outcomeCol || metric) || multiCols.length === 0)) return false;
    if (kind === "sprt" && (!armCol || !(successesCol || metric) || !trialsCol)) return false;
    if (kind === "compliance" && (!kindCol || !rateCol || !taxableCol)) return false;
    return true;
  })();

  return (
    <div>
      {error && (
        <ErrorMessage
          title="Analysis could not run"
          message={error}
          howToFix="Check that the chosen columns exist and match the required type for this analysis."
          className="mb-4"
        />
      )}

      {step === 0 && (
        <section aria-label="Choose dataset">
          <h2 className="mb-1 text-h3 text-foreground">1 · Which dataset drives this analysis?</h2>
          <p className="mb-4 text-sm text-muted">
            Analyses always run against a specific uploaded file so every result stays traceable.
          </p>
          {datasets.length === 0 ? (
            <Card>
              <p className="px-4 py-8 text-center text-sm text-muted">
                Upload a dataset in the project first — every analysis needs real data.
              </p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {datasets.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => {
                      setDatasetId(d.id);
                      setStep(1);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md border px-4 py-3 text-left transition-colors",
                      datasetId === d.id ? "border-accent bg-accent/8" : "border-line hover:bg-surface-2",
                    )}
                  >
                    <span>
                      <span className="block font-medium text-foreground">{d.name}</span>
                      <span className="block text-caption text-muted">
                        {d.rowCount.toLocaleString()} rows · {d.columns.length} columns
                      </span>
                    </span>
                    {d.isDemo && <Badge variant="amber">Demo / Synthetic</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step === 1 && kind === null && (
        <section aria-label="Choose analysis type">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-h3 text-foreground">2 · Pick an analysis type</h2>
              <p className="mt-0.5 text-sm text-muted">Running on “{dataset?.name}”.</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(0)}
              icon={<ArrowLeft aria-hidden className="size-4" />}
            >
              Change dataset
            </Button>
          </div>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {KINDS.map((k) => {
              const ok = canContinueToParams(k);
              const req = kindRequires(k);
              const missing: string[] = [];
              if (req.numeric && numCols.length === 0) missing.push("numeric column");
              if (req.date && dateCols.length === 0) missing.push("date column");
              if (req.string && strCols.length === 0) missing.push("text column");
              return (
                <li key={k}>
                  <button
                    disabled={!ok}
                    onClick={() => {
                      setKind(k);
                      defaultsFor(k);
                      setStep(2);
                    }}
                    className="card flex h-full w-full flex-col items-start gap-1.5 p-4 text-left transition-shadow hover:shadow-pop disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="flex items-center gap-2">
                      <FlaskConical aria-hidden className="size-4 text-accent" />
                      <span className="font-medium text-foreground">{ANALYSIS_KIND_LABELS[k]}</span>
                      <span
                        className={cn(
                          "ml-auto rounded px-1.5 py-0.5 text-caption font-semibold",
                          trustLabelForKind(k) === "Calculated (oracle-validated)"
                            ? "bg-success/10 text-success"
                            : "bg-amber/10 text-amber",
                        )}
                      >
                        {trustLabelForKind(k)}
                      </span>
                    </span>
                    <span className="text-sm text-muted">{ANALYSIS_KIND_DESCRIPTIONS[k]}</span>
                    {!ok && (
                      <span className="text-caption text-warning">Needs a {missing.join(" and ")} in the dataset.</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {step === 2 && kind && dataset && (
        <section aria-label="Configure analysis">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-h3 text-foreground">3 · Configure {ANALYSIS_KIND_LABELS[kind].toLowerCase()}</h2>
              <p className="mt-0.5 text-caption text-muted">
                Dataset: {dataset.name} — every choice below is stored with the result.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setKind(null)}
              icon={<ArrowLeft aria-hidden className="size-4" />}
            >
              Change type
            </Button>
          </div>

          <Card className="p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {kindRequires(kind).numeric && !["correlation", "segmentation"].includes(kind) && (
                <Select
                  label="Metric column (numeric)"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                />
              )}
              {["trend", "forecast", "kpi"].includes(kind) && dateCols.length > 0 && (
                <Select
                  label="Date column"
                  value={dateCol}
                  onChange={(e) => setDateCol(e.target.value)}
                  options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
                />
              )}
              {kind === "kpi" && (
                <Select
                  label="Group by (optional)"
                  value={dimensionCol}
                  onChange={(e) => setDimensionCol(e.target.value)}
                  options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                  placeholder="None"
                />
              )}
              {kind === "variance" && (
                <>
                  <Select
                    label="Group by dimension"
                    value={dimensionCol}
                    onChange={(e) => setDimensionCol(e.target.value)}
                    options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None (use date periods)"
                  />
                  {dateCols.length > 0 && (
                    <Select
                      label="Date column (period compare)"
                      value={dateCol}
                      onChange={(e) => setDateCol(e.target.value)}
                      options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
                      placeholder="None"
                    />
                  )}
                </>
              )}
              {kind === "cohort" && (
                <Select
                  label="Entity / customer column"
                  value={entityCol}
                  onChange={(e) => setEntityCol(e.target.value)}
                  options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                />
              )}
              {kind === "funnel" && (
                <Select
                  label="Stage column"
                  value={stageCol}
                  onChange={(e) => setStageCol(e.target.value)}
                  options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                />
              )}
              {kind === "whatif" && (
                <>
                  <Select
                    label="Driver column"
                    value={metric}
                    onChange={(e) => setMetric(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Outcome column"
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Input
                    label="Perturbation %"
                    value={String(horizon)}
                    onChange={(e) => setHorizon(Number(e.target.value))}
                    helper="Enter a percentage change (e.g. 5 for +5%)"
                  />
                </>
              )}
              {["trend", "forecast", "kpi"].includes(kind) && (
                <Select
                  label="Granularity"
                  value={granularity}
                  onChange={(e) => setGranularity(e.target.value as Granularity)}
                  options={["day", "week", "month", "quarter", "year"].map((g) => ({ value: g, label: g }))}
                />
              )}
              {kind === "forecast" && (
                <>
                  <Select
                    label="Forecast horizon"
                    value={String(horizon)}
                    onChange={(e) => setHorizon(Number(e.target.value))}
                    options={[1, 2, 3, 4, 6, 12].map((h) => ({
                      value: String(h),
                      label: `${h} period${h > 1 ? "s" : ""}`,
                    }))}
                  />
                </>
              )}
              {kind === "distribution" && (
                <Select
                  label="Histogram bins"
                  value={String(bins)}
                  onChange={(e) => setBins(Number(e.target.value))}
                  options={[
                    { value: "0", label: "Auto (recommended)" },
                    ...Array.from({ length: 7 }, (_, i) => ({
                      value: String((i + 1) * 5),
                      label: `${(i + 1) * 5} bins`,
                    })),
                  ]}
                />
              )}
              {kind === "segmentation" && (
                <Select
                  label="Clusters (k)"
                  value={String(k)}
                  onChange={(e) => setK(Number(e.target.value))}
                  options={[2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} clusters` }))}
                />
              )}

              {kind === "regression" && (
                <>
                  <Select
                    label="Group column (exactly 2 values)"
                    value={groupCol}
                    onChange={(e) => setGroupCol(e.target.value)}
                    options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Two distinct values — e.g. control vs treatment."
                  />
                  <Select
                    label="Value column to compare"
                    value={valueCol}
                    onChange={(e) => setValueCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Test"
                    value={testKind}
                    onChange={(e) => setTestKind(e.target.value as typeof testKind)}
                    options={[
                      { value: "welch", label: "Welch's t-test (unequal variances)" },
                      { value: "student", label: "Student's t-test (equal variances)" },
                      { value: "mann-whitney", label: "Mann–Whitney U (nonparametric)" },
                    ]}
                    helper="Welch is the safe default — it assumes nothing about variance."
                  />
                </>
              )}

              {kind === "abtest" && (
                <>
                  <Select
                    label="Arm column (exactly 2 values)"
                    value={armCol}
                    onChange={(e) => setArmCol(e.target.value)}
                    options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                    helper="One row per arm (per period is fine — counts are summed)."
                  />
                  <Select
                    label="Conversions column"
                    value={successesCol}
                    onChange={(e) => setSuccessesCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Trials column"
                    value={trialsCol}
                    onChange={(e) => setTrialsCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Exposures per arm. Must be ≥ conversions."
                  />
                </>
              )}

              {kind === "automl" && (
                <>
                  <Select
                    label="Target column (what to predict)"
                    value={targetCol}
                    onChange={(e) => setTargetCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Task"
                    value={task}
                    onChange={(e) => setTask(e.target.value as typeof task)}
                    options={[
                      { value: "regression", label: "Regression (continuous target)" },
                      { value: "binary-classification", label: "Binary classification (yes/no)" },
                      { value: "multiclass-classification", label: "Multiclass classification" },
                    ]}
                    helper="Needs 12+ rows. Classification targets must be categorical."
                  />
                  <Select
                    label="Cross-validation folds"
                    value={String(cvFolds)}
                    onChange={(e) => setCvFolds(Number(e.target.value))}
                    options={[2, 3, 5, 10].map((n) => ({ value: String(n), label: `${n} folds` }))}
                  />
                </>
              )}

              {kind === "arimax" && (
                <>
                  <Select
                    label="Granularity"
                    value={granularity}
                    onChange={(e) => setGranularity(e.target.value as Granularity)}
                    options={["day", "week", "month", "quarter", "year"].map((g) => ({ value: g, label: g }))}
                  />
                  <Select
                    label="Forecast horizon"
                    value={String(horizon)}
                    onChange={(e) => setHorizon(Number(e.target.value))}
                    options={[1, 2, 3, 4, 6, 12].map((h) => ({
                      value: String(h),
                      label: `${h} period${h > 1 ? "s" : ""}`,
                    }))}
                  />
                </>
              )}

              {kind === "dataquality" && (
                <>
                  <Select
                    label="Severity"
                    value={dqSeverity}
                    onChange={(e) => setDqSeverity(e.target.value as typeof dqSeverity)}
                    options={[
                      { value: "error", label: "Block on any violation" },
                      { value: "warn", label: "Warn only" },
                    ]}
                    helper="'Block' marks the dataset unfit for downstream analysis."
                  />
                  <Select
                    label="Must not be blank (optional)"
                    value={uniqueCol}
                    onChange={(e) => setUniqueCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                    helper="Uniqueness check — use for IDs and invoice numbers."
                  />
                  <Select
                    label="Constrain to allowed values (optional)"
                    value={inSetCol}
                    onChange={(e) => setInSetCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                  />
                  <Input
                    label="Allowed values (comma-separated)"
                    value={allowedValues}
                    onChange={(e) => setAllowedValues(e.target.value)}
                    placeholder="paid, pending, cancelled"
                    helper="Only used when a column is selected above."
                  />
                  <Select
                    label="Range column (optional)"
                    value={rangeCol}
                    onChange={(e) => setRangeCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                  />
                  <Input label="Range min" value={dqMin} onChange={(e) => setDqMin(e.target.value)} placeholder="0" />
                  <Input label="Range max" value={dqMax} onChange={(e) => setDqMax(e.target.value)} placeholder="100" />
                </>
              )}

              {kind === "drift" && (
                <>
                  <Select
                    label="Date column (defines the windows)"
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None — use row order"
                    helper="Windows are split in time order, so a drift in the input is actually detectable."
                  />
                  <Input
                    label="Reference window (% of rows, oldest)"
                    value={String(referenceSplit)}
                    onChange={(e) => setReferenceSplit(Number(e.target.value))}
                    helper="The first N% is the reference; the rest is current. Each needs 20+ rows."
                  />
                </>
              )}

              {kind === "compliance" && (
                <>
                  <Input
                    label="Period (yyyy-mm)"
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                    placeholder="2025-04"
                  />
                  <Select
                    label="Document kind column"
                    value={kindCol}
                    onChange={(e) => setKindCol(e.target.value)}
                    options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Each row must read supply, purchase, import or export."
                  />
                  <Select
                    label="Taxable value column (excl. tax)"
                    value={taxableCol}
                    onChange={(e) => setTaxableCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="GST rate column (%)"
                    value={rateCol}
                    onChange={(e) => setRateCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Read from your data — no rate is assumed. Mixed slabs are taxed per invoice."
                  />
                  <Select
                    label="TDS section column (optional)"
                    value={sectionCol}
                    onChange={(e) => setSectionCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                  />
                  <Select
                    label="Payee PAN column (optional)"
                    value={panCol}
                    onChange={(e) => setPanCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                    helper="A missing or malformed PAN is reported — the payee cannot claim the credit."
                  />
                  <Select
                    label="Counterparty GSTIN column (optional)"
                    value={gstinCol}
                    onChange={(e) => setGstinCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None"
                  />
                  <Input
                    label="Opening ITC credit carried in"
                    value={String(openingCredit)}
                    onChange={(e) => setOpeningCredit(Number(e.target.value))}
                    helper="Credit available from the previous period, in rupees."
                  />
                  <Input
                    label="Audit sample size (0 to skip)"
                    value={String(auditSampleSize)}
                    onChange={(e) => setAuditSampleSize(Number(e.target.value))}
                    helper="Needs 20+ documents. Drawn by a documented, reproducible method."
                  />
                </>
              )}

              {kind === "syntheticcontrol" && (
                <>
                  <Select
                    label="Date column"
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Unit column"
                    value={unitCol}
                    onChange={(e) => setUnitCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Identifies the treated unit and each donor — one row per unit per period."
                  />
                  <Select
                    label="Outcome column"
                    value={metric}
                    onChange={(e) => setMetric(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Input
                    label="Treated unit value"
                    value={treatedValue}
                    onChange={(e) => setTreatedValue(e.target.value)}
                    placeholder="e.g. Delhi"
                    helper="The single unit that received the intervention."
                  />
                  <Select
                    label="Granularity"
                    value={granularity}
                    onChange={(e) => setGranularity(e.target.value as Granularity)}
                    options={["week", "month", "quarter", "year"].map((g) => ({ value: g, label: g }))}
                  />
                  <Input
                    label="Pre-intervention periods"
                    value={String(prePeriods)}
                    onChange={(e) => setPrePeriods(Number(e.target.value))}
                    helper="Leading periods BEFORE the intervention. The synthetic must fit these."
                  />
                </>
              )}

              {kind === "uplift" && (
                <>
                  <Select
                    label="Assignment column"
                    value={treatmentCol}
                    onChange={(e) => setTreatmentCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    helper="1/0 or treated/control. Must come from randomisation."
                  />
                  <Select
                    label="Outcome column"
                    value={outcomeCol}
                    onChange={(e) => setOutcomeCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Task"
                    value={upliftTask}
                    onChange={(e) => setUpliftTask(e.target.value as typeof upliftTask)}
                    options={[
                      { value: "binary", label: "Binary (converted / not)" },
                      { value: "regression", label: "Continuous (spend, revenue)" },
                    ]}
                  />
                  <Select
                    label="Estimator"
                    value={upliftLearner}
                    onChange={(e) => setUpliftLearner(e.target.value as typeof upliftLearner)}
                    options={[
                      { value: "t-learner", label: "T-learner (separate models)" },
                      { value: "s-learner", label: "S-learner (one model)" },
                    ]}
                  />
                  <Select
                    label="CV folds"
                    value={String(upliftFolds)}
                    onChange={(e) => setUpliftFolds(Number(e.target.value))}
                    options={[2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} folds` }))}
                  />
                </>
              )}

              {kind === "sprt" && (
                <>
                  <Select
                    label="Arm column (exactly 2 values)"
                    value={armCol}
                    onChange={(e) => setArmCol(e.target.value)}
                    options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Conversions column"
                    value={successesCol}
                    onChange={(e) => setSuccessesCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Trials column"
                    value={trialsCol}
                    onChange={(e) => setTrialsCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Input
                    label="Detectable lift (%)"
                    value={String(mdeRelative)}
                    onChange={(e) => setMdeRelative(Number(e.target.value))}
                    helper="The smallest relative lift worth detecting. Fix this BEFORE the experiment starts."
                  />
                </>
              )}

              {kind === "accounting" && (
                <>
                  <Select
                    label="Date column"
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    options={dateCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Account code column"
                    value={accountCol}
                    onChange={(e) => setAccountCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    helper="Matched against the standard chart of accounts."
                  />
                  <Select
                    label="Debit column"
                    value={debitCol}
                    onChange={(e) => setDebitCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Credit column"
                    value={creditCol}
                    onChange={(e) => setCreditCol(e.target.value)}
                    options={numCols.map((c) => ({ value: c.name, label: c.name }))}
                  />
                  <Select
                    label="Voucher reference (optional)"
                    value={referenceCol}
                    onChange={(e) => setReferenceCol(e.target.value)}
                    options={columns.map((c) => ({ value: c.name, label: c.name }))}
                    placeholder="None — treat file as one entry"
                    helper="Rows sharing a reference become one journal entry."
                  />
                </>
              )}
            </div>

            {["correlation", "segmentation", "automl", "uplift", "drift"].includes(kind) && numCols.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium text-foreground">
                  Numeric columns to include (auto-suggests the strongest candidates)
                </p>
                <div className="flex flex-wrap gap-3">
                  {numCols.map((c) => (
                    <Checkbox
                      key={c.name}
                      label={c.name}
                      checked={multiCols.includes(c.name)}
                      onChange={(v) => setMultiCols((m) => (v ? [...m, c.name] : m.filter((x) => x !== c.name)))}
                    />
                  ))}
                </div>
              </div>
            )}

            {kind === "arimax" && numCols.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-sm font-medium text-foreground">Exogenous drivers (at least one required)</p>
                <p className="mb-2 text-caption text-muted">
                  The model explains movement in the target using these columns. Their future values are projected from
                  the last observed trend — a modelling assumption, shown on the result.
                </p>
                <div className="flex flex-wrap gap-3">
                  {numCols
                    .filter((c) => c.name !== metric)
                    .map((c) => (
                      <Checkbox
                        key={c.name}
                        label={c.name}
                        checked={regressors.includes(c.name)}
                        onChange={(v) => setRegressors((r) => (v ? [...r, c.name] : r.filter((x) => x !== c.name)))}
                      />
                    ))}
                </div>
              </div>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {filterCol && (
                <Select
                  label="Filter column"
                  value={filterCol}
                  onChange={(e) => setFilterCol(e.target.value)}
                  options={strCols.map((c) => ({ value: c.name, label: c.name }))}
                  placeholder="No filter"
                />
              )}
              {filterCol && filterValue && (
                <Input
                  label="Filter value"
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  helper="Exact-match filter applied before computing."
                />
              )}
            </div>
            {strCols.length > 0 && !filterCol && (
              <button
                className="mt-3 text-caption font-medium text-accent hover:underline"
                onClick={() => {
                  setFilterCol(strCols[0]?.name ?? "");
                }}
              >
                + Add a categorical filter
              </button>
            )}
            {filterCol && (
              <button
                className="mt-2 text-caption text-muted hover:underline"
                onClick={() => {
                  setFilterCol("");
                  setFilterValue("");
                }}
              >
                Remove filter
              </button>
            )}

            <div className="mt-5 border-t border-line pt-4">
              <Input
                label="Result title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`${ANALYSIS_KIND_LABELS[kind]} · ${metric || dataset.name}`}
              />
            </div>
          </Card>

          <div className="mt-4 flex items-center justify-between">
            <Field label="" htmlFor="">
              <span className="text-caption text-muted">
                Results include stats, charts, data-quality warnings and a full “How was this calculated?” breakdown.
              </span>
              <span className="mt-1 block text-caption">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-semibold",
                    trustLabelForKind(kind) === "Calculated (oracle-validated)"
                      ? "bg-success/10 text-success"
                      : "bg-amber/10 text-amber",
                  )}
                >
                  {trustLabelForKind(kind)}
                </span>{" "}
                <span className="text-muted">
                  {trustLabelForKind(kind) === "Calculated (oracle-validated)"
                    ? "— every figure this run produces is verified against SciPy/NumPy/statsmodels oracles in CI and traceable via provenance; the versions panel on the result records it as an immutable snapshot."
                    : "— prototype-grade logic: the result is always labelled as such and never presented as production-verified."}
                </span>
              </span>
            </Field>
            <Button onClick={run} loading={running} disabled={!canRun} icon={<Play aria-hidden className="size-4" />}>
              Run {ANALYSIS_KIND_LABELS[kind]}
            </Button>
          </div>
        </section>
      )}

      {step < 2 && (
        <div className="mt-4 flex justify-between">
          {step === 1 && (
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
          )}
          {step === 0 && datasets.length > 0 && (
            <Button
              className="ml-auto"
              disabled={!datasetId}
              onClick={() => setStep(1)}
              icon={<ArrowRight aria-hidden className="size-4" />}
            >
              Continue
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
