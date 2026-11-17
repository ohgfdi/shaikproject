/**
 * Ledgerly domain types. These mirror the JSON payloads persisted in Prisma
 * TEXT columns and are the single source of truth for the analysis engine,
 * API contracts and UI components. Keep this file dependency-free.
 */

// ---------------------------------------------------------------------------
// Datasets & profiling
// ---------------------------------------------------------------------------

export type ColType = "string" | "number" | "date" | "boolean";

export interface ColumnDef {
  name: string;
  type: ColType;
}

export interface TopValue {
  value: string;
  count: number;
}

export interface ColumnStat {
  name: string;
  type: ColType;
  /** Count of empty/blank cells in the analysed rows. */
  missing: number;
  /** Number of distinct values; -1 when too many to track exactly. */
  distinct: number;
  /** True when ≥ 99.5% of values are identical (near-constant column). */
  nearConstant: boolean;
  /** Numeric columns only */
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  stddev?: number;
  q1?: number;
  median?: number;
  q3?: number;
  /** Count of values beyond 1.5×IQR (classic box-plot fences). */
  outlierCount?: number;
  /** Categorical columns only — top 5 most frequent values. */
  topValues?: TopValue[];
  /** Date columns only */
  minDate?: string;
  maxDate?: string;
}

export interface DatasetProfile {
  /** Rows actually inspected (may be a labelled sample for very large files). */
  analyzedRows: number;
  sampled: boolean;
  rowCount: number;
  columnCount: number;
  columns: ColumnDef[];
  stats: Record<string, ColumnStat>;
  /** Exact duplicate rows found within the analysed rows. */
  duplicateRows: number;
  qualityWarnings: string[];
}

export interface QualitySeverity {
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  column?: string;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type ChartKind =
  | "kpi"
  | "line"
  | "area"
  | "bar"
  | "stacked-bar"
  | "donut"
  | "scatter"
  | "histogram"
  | "box"
  | "heatmap"
  | "funnel"
  | "waterfall"
  | "pivot"
  | "map"
  | "decomposition-tree"
  | "key-influencers"
  // Advanced visualization kinds for new feature categories.
  | "distributed-plot"
  | "stream-plot"
  | "dl-plot"
  | "nlp-vis"
  | "feature-plot"
  | "serving-plot"
  | "hte-plot"
  | "iv-plot"
  | "geospatial-plot";

export interface KpiCard {
  label: string;
  /** Pre-formatted display string */
  value: string;
  deltaPct?: number | null;
  deltaLabel?: string;
  spark?: number[];
  hint?: string;
  /** Aggregation the value represents (optional for producers; renderers default to sum). */
  kind?: "sum" | "mean" | "min" | "max" | "count";
}

export interface Point {
  x: number;
  y: number;
  label?: string;
}

export interface ChartSeries {
  name: string;
  /** category series values */
  data?: (number | null)[];
  /** scatter points (scatter chart only) */
  points?: Point[];
  /** box-plot: [min, q1, median, q3, max] */
  box?: [number, number, number, number, number];
  /** colour (CSS) override */
  color?: string;
  /** waterfall: indexes that are running totals (not deltas) */
  totals?: number[];
}

export interface ChartSpec {
  kind: ChartKind;
  title: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  categories?: string[];
  series: ChartSeries[];
  /** heatmap rows (when categories holds x labels) */
  rowLabels?: string[];
  kpis?: KpiCard[];
  /** Set when the chart type is a labelled placeholder. */
  placeholderNote?: string;
  /** Decomposition tree data (for kind="decomposition-tree") */
  aiTree?: import("@/lib/engine/ai-visuals").TreeNode;
  /** Key influencers data (for kind="key-influencers") */
  aiInfluencers?: import("@/lib/engine/ai-visuals").KeyInfluencersResult;
  /** What-if simulation result (S5c 3D crossover scene) */
  aiWhatIf?: import("@/lib/types").WhatIfResult;
  /** Geographic map data (for kind="map") — one entry per region */
  mapData?: { region: string; value: number }[];
}

export interface TableSpec {
  title: string;
  columns: { key: string; label: string; format?: "number" | "pct" | "date" | "text" }[];
  rows: (string | number | null)[][];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type AnalysisKind =
  | "eda"
  | "trend"
  | "kpi"
  | "correlation"
  | "distribution"
  | "forecast"
  | "variance"
  | "whatif"
  | "segmentation"
  | "cohort"
  | "funnel"
  // Advanced statistical engines — same upload → analysis contract, but the
  // method families an analyst reaches for after the descriptive pass.
  | "abtest"
  | "automl"
  | "arimax"
  | "regression"
  | "dataquality"
  | "accounting"
  // Remaining advanced engines — written and oracle-tested, previously with
  // zero importers (no user could reach them).
  | "syntheticcontrol"
  | "uplift"
  | "sprt"
  | "drift"
  | "compliance"
  // CA financial-statement and tax engines.
  | "fsanalysis"
  | "fsratio"
  | "taxaudit"
  | "compcal"
  | "gst"
  | "itr"
  | "tds"
  | "roc"
  | "payroll"
  | "advancetax"
  | "auditfield"
  | "indas"
  | "efiling"
  | "practiceman"
  // Elite causal inference — 2×2 difference-in-differences with a placebo
  // falsification test on the parallel-trends assumption.
  | "did"
  // Survival analysis — Kaplan–Meier curves, log-rank and Cox proportional
  // hazards regression (time-to-event with censoring).
  | "survival"
  // Bayesian estimation — conjugate posterior for regression, random-walk
  // Metropolis posterior sampling and exact Gaussian-process regression.
  | "bayesian"
  // Seasonal time series — SARIMA/SARIMAX by conditional least squares with
  // AICc model selection and multi-fold rolling-origin cross-validation.
  | "sarima"
  // Distributed & big-data compute.
  | "distributed"
  // Streaming data ingestion & real-time processing.
  | "streaming"
  // Deep learning at scale — GPU training, XGBoost, PyTorch live.
  | "deep-learning"
  // NLP / unstructured text / image / audio analysis.
  | "nlp"
  // Feature store query and management.
  | "feature-store"
  // Real-time serving and low-latency predictions.
  | "real-time-serving"
  // Individual treatment effect / HTE beyond average uplift.
  | "hte"
  // Advanced causal: IV / do-calculus for policy evaluation.
  | "iv-calculus"
  // Geospatial / advanced mapping and regional analysis.
  | "geospatial" | "map";

export interface AnalysisBaseConfig {
  dateCol?: string | null;
  dimensionCol?: string | null;
  filterCol?: string | null;
  filterValue?: string | null;
}

export interface TrendConfig extends AnalysisBaseConfig {
  dateCol: string;
  metric: string;
  granularity: Granularity;
}
export interface KpiConfig extends AnalysisBaseConfig {
  metric: string;
  dateCol?: string | null;
  granularity: Granularity;
}
export interface CorrelationConfig extends AnalysisBaseConfig {
  columns: string[];
}
export interface DistributionConfig extends AnalysisBaseConfig {
  column: string;
  bins: number;
}
export interface ForecastConfig extends AnalysisBaseConfig {
  dateCol: string;
  metric: string;
  granularity: Granularity;
  horizon: number; // periods ahead
  /**
   * Expanding-window rolling-origin folds for multi-fold out-of-sample error
   * (0 = single walk-forward backtest only). Each fold re-fits the winner and
   * forecasts the next period on data the model has not seen.
   */
  cvFolds: number;
}

// --- Advanced statistical analyses ------------------------------------------

/**
 * Two-proportion A/B test over per-arm counts. Requires four numbers; the
 * dataset supplies them as columns so the result is reproducible and auditable
 * rather than hand-typed into a form.
 */
export interface AbTestConfig extends AnalysisBaseConfig {
  /** Column holding each arm's conversion count. */
  successesCol: string;
  /** Column holding each arm's total trials/exposures. */
  trialsCol: string;
  /** Column labelling which arm each row is (exactly two distinct values). */
  armCol: string;
  /** Optional per-row value used to split each arm (e.g. revenue per user). */
  valueCol?: string | null;
  alpha: number;
  power: number;
}

/** AutoML: search the algorithm space and report the full leaderboard. */
export interface AutoMlConfig extends AnalysisBaseConfig {
  targetColumn: string;
  featureColumns: string[];
  task: "regression" | "binary-classification" | "multiclass-classification";
  cvFolds: number;
  /** Cap on candidates evaluated; the grid is truncated deterministically. */
  maxCandidates: number;
}

/** Dynamic regression (ARIMAX) with exogenous regressors and AR(1) errors. */
export interface ArimaxConfig extends AnalysisBaseConfig {
  dateCol: string;
  metric: string;
  granularity: Granularity;
  horizon: number;
  /** Exogenous regressor columns; at least one is required. */
  regressors: string[];
  level: 0.8 | 0.95;
}

/**
 * Inference on a segmented comparison: the same nonparametric/effect-size
 * battery from `elite-stats`, run across two user-selected groups so the
 * output is a decision ("is B better than A"), not a pile of p-values.
 */
export interface RegressionConfig extends AnalysisBaseConfig {
  /** Column identifying the two comparison groups (exactly two values). */
  groupCol: string;
  /** Numeric column to compare between the groups. */
  valueCol: string;
  /** Which parametric test to run for the mean comparison. */
  test: "welch" | "student" | "mann-whitney";
  /** Apply Benjamini–Hochberg across the produced p-values. */
  adjust: boolean;
  alpha: number;
}

/**
 * Data-contract check. `expectations` are built from the selected column
 * rather than free-typed, so the checks run are always ones the engine
 * implements.
 */
export interface DataQualityConfig extends AnalysisBaseConfig {
  /** Column that must never be blank (empty string is a violation). */
  requiredCol: string;
  /** Optional column that must be unique (IDs, invoice numbers). */
  uniqueCol: string | null;
  /** Optional column constrained to an allowed value set. */
  inSetCol: string | null;
  allowedValues: string[];
  /** Optional numeric column constrained to a range. */
  rangeCol: string | null;
  min: number | null;
  max: number | null;
  /** Block (error) on any violation, or only warn. */
  severity: "error" | "warn";
}

/**
 * Double-entry accounting over an uploaded voucher file.
 *
 * The dataset is the raw voucher ledger: one row per posting side, with the
 * account code and a debit OR credit amount. Columns are named explicitly
 * because account-code conventions differ between firms.
 */
export interface AccountingConfig extends AnalysisBaseConfig {
  dateCol: string;
  /** Column holding the chart-of-accounts code (e.g. "1010"). */
  accountCol: string;
  /** Column holding the debit amount (blank/0 on a credit row). */
  debitCol: string;
  /** Column holding the credit amount (blank/0 on a debit row). */
  creditCol: string;
  /** Optional narration column. */
  narrationCol: string | null;
  /** Optional voucher reference, used to group rows into entries. */
  referenceCol: string | null;
  from: string | null;
  to: string | null;
}
export interface VarianceConfig extends AnalysisBaseConfig {
  metric: string;
  dimensionCol?: string | null;
  dateCol?: string | null;
}
export interface SegmentationConfig extends AnalysisBaseConfig {
  columns: string[];
  k: number;
}
export interface CohortConfig extends AnalysisBaseConfig {
  dateCol: string;
  entityCol: string;
}
export interface FunnelConfig extends AnalysisBaseConfig {
  stageCol: string;
  /** custom stage order (empty = derive by average position) */
  stages?: string[];
}

/**
 * Synthetic control: a treated unit plus donor units, measured over time,
 * with a known pre-treatment window. Requires a panel (one row per unit per
 * period).
 */
export interface SyntheticControlConfig extends AnalysisBaseConfig {
  dateCol: string;
  /** Column identifying the unit (treated or donor). */
  unitCol: string;
  /** Column holding the outcome. */
  metric: string;
  granularity: Granularity;
  /** Which unit value is the treated one. */
  treatedValue: string;
  /** Number of leading periods treated BEFORE the intervention. */
  prePeriods: number;
  maxIter: number;
}

/** Treatment-effect heterogeneity over a randomised experiment. */
export interface UpliftConfig extends AnalysisBaseConfig {
  /** Numeric feature columns. */
  features: string[];
  /** Column with 1/0 (or treated/control) assignment. */
  treatmentCol: string;
  /** Outcome column. */
  outcomeCol: string;
  task: "binary" | "regression";
  learner: "t-learner" | "s-learner";
  folds: number;
}

/** Sequential probability ratio test over two binomial arms. */
export interface SprtConfig extends AnalysisBaseConfig {
  successesCol: string;
  trialsCol: string;
  armCol: string;
  /** Relative lift worth detecting (0.05 = detect a 5% lift). */
  mdeRelative: number;
  alpha: number;
  beta: number;
}

/**
 * Drift detection between a reference window and the current window.
 *
 * `referenceSplit` is the fraction of rows (ordered by the date column) treated
 * as the reference window; the remainder is "current". Splitting in data order
 * rather than randomly keeps the two windows temporally distinct.
 */
export interface DriftConfig extends AnalysisBaseConfig {
  dateCol: string | null;
  granularity: Granularity;
  /** Fraction of the time span used as the reference window (default 0.5). */
  referenceSplit: number;
  /** Columns to test; empty means every column. */
  columns: string[];
}

/**
 * Indian compliance over an invoice-level ledger.
 *
 * The uploaded rows must be document-level (one row per invoice), carrying a
 * tax rate and an inward/outward direction. Section rates and the GST slab are
 * taken from the columns themselves rather than hardcoded, because a rate
 * baked into the code goes stale the moment a notification changes it.
 */
export interface ComplianceConfig extends AnalysisBaseConfig {
  /** Human period label, e.g. "2025-04" — echoed onto the report. */
  period: string;
  /** "supply" | "purchase" | "import" | "export". */
  kindCol: string;
  /** Column carrying the GST rate as a percentage (e.g. 18). */
  rateCol: string;
  /** Taxable value EXCLUDING tax. */
  taxableCol: string;
  /** Optional: indicates reverse-charge. */
  reverseChargeCol: string | null;
  /** Optional: TDS section code per row (e.g. "194J"). */
  sectionCol: string | null;
  /** Optional: payee PAN, validated so missing PANs are reported. */
  panCol: string | null;
  /** Optional: counterparty GSTIN, format-validated. */
  gstinCol: string | null;
  /** Opening ITC credit carried into the period, in major units. */
  openingCredit: number;
  /** Run the audit sample over the taxable values. */
  auditSampleSize: number;
}

/**
 * Distributed / big-data batch execution.
 *
 * Models a columnar, partitioned execution plan (the Spark shape) over the
 * in-memory dataset: column pruning, predicate pushdown into a selection
 * vector, two-phase partial→final aggregation, skew salting, shuffle cost and
 * the resulting Amdahl speedup. The compute is genuinely partitioned and
 * genuinely two-phase — the numbers are not a single-threaded result relabelled.
 */
export interface DistributedConfig extends AnalysisBaseConfig {
  metric: string;
  /** Optional grouping column — its presence forces a shuffle. */
  dimensionCol: string | null;
  op: "sum" | "mean" | "min" | "max" | "count" | "distinct" | "variance";
  /** Number of workers/partitions to execute across. */
  workers: number;
  /** Number of random salts used to split a skewed hot key (0 = off). */
  saltingFactor: number;
}

/** Streaming windowed aggregation over an event-time column. */
export interface StreamingConfig extends AnalysisBaseConfig {
  dateCol: string;
  metric: string;
  granularity: Granularity;
  window: "tumbling" | "sliding" | "session";
  /** Window length in periods (also the session gap for session windows). */
  windowSize: number;
  /** Slide step in periods (sliding windows only). */
  slide: number;
  /** Periods of tolerated lateness before an event is dropped. */
  allowedLateness: number;
  watermark: "event-time" | "bounded-out-of-orderness";
  /** Aggregate accumulated inside each window. */
  op: "sum" | "mean" | "min" | "max" | "count";
}

/**
 * Deep learning at scale.
 *
 * `architecture` picks the real algorithm: `xgboost` runs exact greedy split
 * search with gradients accumulated into per-worker histograms and merged by
 * all-reduce (how XGBoost actually parallelises); `mlp` runs a data-parallel
 * MLP whose parameter gradients are averaged every step (DDP). `workers` is
 * the shard count — changing it changes the reported speedup.
 */
export interface DeepLearningConfig extends AnalysisBaseConfig {
  features: string[];
  target: string;
  task: "binary" | "regression";
  architecture: "xgboost" | "mlp";
  /** Data-parallel shards. */
  workers: number;
  hidden: number;
  epochs: number;
  learningRate: number;
  batchSize: number;
  depth: number;
  /** Rounds (xgboost) / epochs (mlp) without improvement before stopping. */
  patience: number;
  /** "auto" probes WebGPU/WebGL; "cpu" forces the deterministic scalar path. */
  device: "auto" | "cpu" | "gpu";
}

/** Unstructured-text analysis. Image/audio use the numeric media configs below. */
export interface NlpConfig extends AnalysisBaseConfig {
  textCol: string;
  task: "keywords" | "sentiment" | "topics" | "similarity" | "entities" | "language" | "classify";
  /** Optional supervision for `classify` (0/1 or two distinct labels). */
  labelCol: string | null;
  numTopics: number;
  topK: number;
  /** Minimum document frequency for a term to enter the vocabulary. */
  minDf: number;
  /** Documents to compare pairwise for `similarity`. */
  sampleSize: number;
}

/** Audio waveform features over a numeric column of PCM samples. */
export interface AudioConfig extends AnalysisBaseConfig {
  sampleCol: string;
  /** Sample rate in Hz (default 16,000). */
  sampleRate: number;
  frameSize: number;
}

/** Raster image features over numeric pixel columns (RGB, row-major). */
export interface ImageConfig extends AnalysisBaseConfig {
  redCol: string;
  greenCol: string;
  blueCol: string;
  /** Dominant-colour clusters extracted (k-means on RGB). */
  clusters: number;
}

/**
 * Feature store retrieval with point-in-time correctness.
 *
 * `eventTimeCol` is the anti-leakage contract: a feature row is only visible to
 * an entity if the feature's own event time is at or before the entity's. The
 * engine reports how many rows a naive "latest value" read would have leaked.
 */
export interface FeatureStoreConfig extends AnalysisBaseConfig {
  entityCol: string;
  featureCols: string[];
  eventTimeCol: string | null;
  /** Max acceptable feature age in days before a row is called stale. */
  maxFeatureAgeDays: number;
  /** Snapshot the online store is diffed against for the parity check. */
  onlineSnapshotVersion: number;
}

/**
 * Low-latency serving benchmark.
 *
 * Scores held-out traffic through a registry with an LRU cache, micro-batching,
 * deterministic A/B allocation, a canary rollout and shadow mode, reporting
 * p50/p95/p99 latency and the SLO verdict.
 */
export interface RealTimeServingConfig extends AnalysisBaseConfig {
  featureCols: string[];
  target: string;
  targetKind: "binary" | "regression";
  cacheSize: number;
  /** Canary share of traffic, 0–1. */
  canaryShare: number;
  /** Also score every request with the incumbent (shadow mode). */
  shadow: boolean;
  slaMs: number;
}

/** Heterogeneous treatment effects beyond the average. */
export interface HteConfig extends AnalysisBaseConfig {
  features: string[];
  treatmentCol: string;
  outcomeCol: string;
  learner: "dr-learner" | "r-learner" | "forest";
  folds: number;
  /** Causal-forest regularisation strength (γ) and minimum leaf size. */
  regularization: number;
  minLeaf: number;
  depth: number;
  /** Number of quantile segments for the CATE-by-quantile table. */
  quantileSegments: number;
}

/** Instrumental variables and do-calculus. */
export interface IvCalculusConfig extends AnalysisBaseConfig {
  outcomeCol: string;
  treatmentCol: string;
  /** Excluded instrument(s), comma-separated column names. */
  instrumentCols: string[];
  /** Conditioning set for the backdoor adjustment. */
  controlCols: string[];
  estimator: "2sls" | "liml";
  alpha: number;
}

/** Geospatial analysis over point or region data. */
export interface GeospatialConfig extends AnalysisBaseConfig {
  latCol: string;
  lonCol: string;
  metric: string;
  /** Region/category column for the choropleth and spatial join. */
  regionCol: string | null;
  weightCol: string | null;
  method: "morans-i" | "getis-ord" | "distance-decay" | "clusters" | "hotspots";
  /** Neighbourhood band in km, or k-nearest when > 0. */
  bandKm: number;
  /** Permutation replicates for the inference tests. */
  permutations: number;
}

/** Choropleth map analysis config — one region column + one metric column. */
export interface MapConfig extends AnalysisBaseConfig {
  /** Column holding the region name (e.g. "USA", "Maharashtra", "England"). */
  regionCol: string;
  /** Column holding the numeric metric value (e.g. revenue, count, profit). */
  metricCol: string;
}

/**
 * What-if simulation: shift a driver column by a percentage and project the
 * impact on an outcome through the fitted linear model. The engine fits the
 * in-app projection model (`runWhatIf`), so the numbers are real regressions,
 * not arithmetic on averages.
 */
export interface WhatIfConfig extends AnalysisBaseConfig {
  /** Driver column whose values are shifted (pctChange percent). */
  driverColumn: string;
  /** Outcome column the impact is projected onto. */
  outcomeColumn: string;
  /** Relative shift applied to the driver, in percent (10 = +10%). */
  pctChange: number;
  /** Conditioning columns held at their observed values in the projection. */
  controlColumns: string[];
}

/**
 * 2×2 difference-in-differences with a placebo falsification test.
 *
 * Split rows into treated/control and pre/post, then run the closed-form DiD
 * estimator. When at least two pre-periods exist, the same 2×2 is re-run one
 * period before treatment as a placebo test of the parallel-trends
 * assumption. Cell standard deviations feed an honest SE; without them the
 * estimate is reported descriptively only.
 */
export interface DidConfig extends AnalysisBaseConfig {
  /** Column splitting rows into treated and control groups. */
  groupCol: string;
  /** Value of `groupCol` that identifies the treated group. */
  treatedValue: string;
  /** Column splitting rows into pre/post periods (a date, or an explicit phase label). */
  periodCol: string;
  /** Value of `periodCol` that identifies the post-treatment period. */
  postValue: string;
  /** Outcome column. */
  metric: string;
  /**
   * Optional: when set (yyyy-mm-dd), periods before this date are "pre" and
   * periods on/after are "post" — overriding `postValue` on a date column.
   */
  interventionDate: string | null;
}

/**
 * Survival analysis: Kaplan–Meier curves with Greenwood variance, a log-rank
 * test between two groups, and Cox proportional hazards regression (Breslow
 * ties) with Wald / likelihood-ratio inference and a concordance index.
 */
export interface SurvivalConfig extends AnalysisBaseConfig {
  /** Time-to-event or censoring, in the unit of the column (must be > 0). */
  timeCol: string;
  /** 1 = event observed, 0 = right-censored. */
  eventCol: string;
  /** Optional grouping column for the log-rank test (exactly two groups). */
  groupCol: string | null;
  /** Numeric covariates entered into the Cox model. */
  covariates: string[];
}

/**
 * Bayesian estimation: a conjugate Normal–Inverse-Gamma posterior over
 * regression coefficients (posterior means, credible intervals, and an
 * optional random-walk Metropolis sample), or an exact Gaussian-process
 * regression with posterior predictive intervals.
 */
export interface BayesianConfig extends AnalysisBaseConfig {
  target: string;
  features: string[];
  model: "regression" | "gp";
  /** Credible interval width, e.g. 0.95 for a 95% interval. */
  credibleLevel: number;
  /** Prior standard deviation on each coefficient (regression model). */
  priorSD: number;
  /** Random-walk Metropolis draws (0 = skip sampling, use the closed form). */
  mcmcSamples: number;
  /** GP length-scale (gp model). */
  lengthScale: number;
  /** GP observation noise standard deviation (gp model). */
  noiseSD: number;
}

/**
 * Seasonal ARIMA/SARIMAX: a grid of (p,q)×(P,Q) candidates over the
 * differenced series, fit by conditional least squares and selected by AICc,
 * with optional exogenous regressors and expanding-window rolling-origin
 * cross-validation for out-of-sample accuracy.
 */
export interface SarimaConfig extends AnalysisBaseConfig {
  dateCol: string;
  metric: string;
  granularity: Granularity;
  /** Seasonal period (12 for monthly data, 4 for quarterly, 7 for daily…). */
  seasonalPeriods: number;
  /** Forecast horizon in periods. */
  horizon: number;
  /** Max non-seasonal AR/MA orders searched (grid is 0…maxOrder). */
  maxOrder: number;
  /** Max seasonal AR/MA orders searched (0 or 1). */
  maxSeasonalOrder: number;
  /** Optional exogenous regressor columns (SARIMAX). */
  regressors: string[];
  /** Rolling-origin folds for out-of-sample error (0 = skip CV). */
  cvFolds: number;
}

export interface FsAnalysisConfig extends AnalysisBaseConfig {
  /** Current-period label, e.g. "FY 2025-26". */
  currentLabel: string;
  /** Prior-period label, e.g. "FY 2024-25". */
  priorLabel: string;
  /** Income statement lines current period, in statement order. */
  currentIsLines: string[];
  /** Prior income statement lines, same order where available (nullable). */
  priorIsLines: string[] | null;
  /** Balance sheet lines current period, in statement order. */
  currentBsLines: string[];
  /** Prior balance sheet lines, same order where available (nullable). */
  priorBsLines: string[] | null;
  /** Cash-flow lines current period, in statement order. */
  currentCfLines: string[];
  /** Prior cash-flow lines, same order where available (nullable). */
  priorCfLines: string[] | null;
  /** Optional base overrides (minor units). When omitted, derived from the lines. */
  isBase?: number | null;
  bsBase?: number | null;
  cfBase?: number | null;
}

export interface FsRatioConfig extends AnalysisBaseConfig {
  /** One line per row: statement key + amount. The engine picks ratios from keys. */
  lines: { key: string; amount: number }[];
  /** Which ratio families to surface. When empty, all are attempted. */
  families?: ("liquidity" | "solvency" | "profitability" | "efficiency" | "turnover" | "workingCapital" | "cashFlow")[];
  /** Optional peer benchmark table for the benchmark readout. */
  peerBenchmarks?: { ratio: string; value: number }[];
}

export interface TaxAuditConfig extends AnalysisBaseConfig {
  /** Financial year, e.g. "2025-26". */
  fy: string;
  /** Entity type: "individual" | "hir india" | "company" | "firm" | "aop" | "boi" | "trust" | "cooperative". */
  entityType: string;
  /** Assessee category relevant for turnovers thresholds. */
  category?:
    | "resident"
    | "non-resident"
    | "domestic-company"
    | "unlisted-company"
    | "hindu-undivided-family"
    | "partnership-firm"
    | "llp";
  /** Gross turnover/receipts for the year, in major units (INR). */
  turnover: number;
  /** Non-cash-receipts / presumptive turnover additions, if any. */
  presumptiveTurnover: number;
  /** Turnover/gross receipts from the business that may be exempt or non-taxable. */
  exemptTurnover: number;
  /** Whether books of account are prescribed/required to be maintained. */
  booksRequired: boolean;
  /** Whether audited turnover exceeds the basic exemption/slabs being considered. */
  auditedTurnoverFlag: boolean;
  /** Professional services? (affects presumptive provisions). */
  professionalServices: boolean;
  /** Opted into presumptive scheme under 44AD/ADA/AGS? */
  presumptiveOpted: boolean;
  /** Digital transactions share, if available. */
  digitalReceiptsPct: number;
}

export interface CompCalConfig extends AnalysisBaseConfig {
  /** Client/firm reference period start, ISO date. */
  periodStart: string;
  /** Client/firm reference period end. */
  periodEnd: string;
  /** Jurisdiction. */
  jurisdiction: "india";
  /** Entity type for ROC/PT applicability. */
  entityType: "company" | "llp" | "partnership" | "proprietorship" | "individual";
  /** Whether GST registered. */
  gstRegistered: boolean;
  /** Whether withholding agent for TDS/TCS. */
  withholdingAgent: boolean;
  /** State for professional tax. */
  professionalTaxState?: string;
  /** Show only items due/on/overdue in window. */
  windowDays: number;
}

export interface GstConfig extends AnalysisBaseConfig {
  /** GSTIN of the taxpayer. */
  gstin: string;
  /** Tax period, YYYY-MM. */
  period: string;
  /** Outward supplies ledger: invoice-level rows. */
  outwardLedger: { inv: string; taxable: number; taxRate: number; place: string; eway: boolean }[];
  /** Inward supplies/import ledger. */
  inwardLedger: { inv: string; taxable: number; taxRate: number; rcm: boolean }[];
  /** Import of goods/services with customs data, if any. */
  imports: { inv: string; taxable: number; igstRate: number; cess: number }[];
  /** Opening ITC balance for the period (major units). */
  openingIct: number;
  /** Available ITC as per 2A/2B from counter-party filings. */
  availableIct2A2B: number;
  /** Reverse charge inward supplies, if any. */
  reverseCharge: number;
  /** Cess ledger, if applicable. */
  cessLedger: { inv: string; taxable: number; rate: number }[];
}

export interface ItrConfig extends AnalysisBaseConfig {
  /** FY, e.g. "2025-26". */
  fy: string;
  /** Assessee type & category. */
  assesseeType: "individual" | "hir india" | "company" | "firm" | "llp" | "aop" | "boi" | "trust";
  /** Residential status. */
  residentialStatus: "resident" | "non-resident" | "not ordinarily resident";
  /** Gross total income components (heads). */
  incomeHeads: {
    salary: number;
    houseProperty: number;
    businessProfession: number;
    capitalGains: number;
    otherSources: number;
    agricultural: number;
  };
  /** Deductions chapter VI-A. */
  deductions: {
    section80C: number;
    section80D: number;
    section80E: number;
    section80G: number;
    section80GG: number;
    section80TTA: number;
    section80TTB: number;
    nopNorm: number;
    otherDeductions: number;
  };
  /** HRA components for computation. */
  hra: { received: number; paidRent: number; city: boolean; metro: boolean; actualRent: number };
  /** Losses brought forward & set-off. */
  losses: { bhplBroughtFwd: number; bhplSetOff: number; cglBroughtFwd: number; cglSetOff: number };
  /** Interest from loans/advances for Schedule AI. */
  scheduleAi: { interestPaid: number; interestReceived: number };
  /** Tax payments & TDS/TCS. */
  prepaidTax: { tds: number; tcs: number; advanceTax: number; selfAssessment: number; demands: number };
  /** Form type selected/brief. */
  formType: "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4" | "ITR-5" | "ITR-6" | "ITR-7";
  /** Surcharge + cess applicability flags. */
  surcharges: { hvilag: boolean; healthcare: boolean };
}

export interface TdsConfig extends AnalysisBaseConfig {
  /** Employer/withholder PAN. */
  payerPan: string;
  /** Assessment year. */
  assessmentYear: string;
  /** Payments/transactions subject to TDS. */
  transactions: {
    section: string;
    payeeName: string;
    payeePan: string;
    amount: number;
    rate: number;
    threshold: number;
    dateOfPayment: string;
    dateOfDeduction: string;
    deposited: boolean;
    challan: string;
  }[];
  /** Aggregate threshold tracking (cross-section). */
  aggregateThresholds: { section: string; cumulative: number }[];
  /** Late-deduction/late-deposit events. */
  defaults: { section: string; delayDays: number; reason: string }[];
}

export interface RocConfig extends AnalysisBaseConfig {
  /** CIN. */
  cin: string;
  /** Company type. */
  companyType: "private-limited" | "public-limited" | "one-person" | "section-8" | "llp";
  /** Financial year end. */
  financialYearEnd: string;
  /** Dates of relevant events. */
  events: {
    kind: "balance-sheet-date" | "agm-date" | "charges-created" | "charges-released" | "directors-change" | "kyc-due";
    date: string;
  }[];
  /** Charges details. */
  charges: { dateOfCreation: string; amount: number; securedDebts: number; asset: string }[];
  /** Directors detail for D&O. */
  directors: { name: string; din: string; kycStatus: "done" | "pending" }[];
}

export interface PayrollConfig extends AnalysisBaseConfig {
  /** Payroll period. */
  period: string;
  /** State for PT + labour law mapping. */
  state: string;
  /** Employee count brackets if needed. */
  employeeCount: number;
  /** Salary structures. */
  employees: {
    id: string;
    name: string;
    basic: number;
    da: number;
    hra: number;
    specialAllowance: number;
    otherAllowances: number;
    bonusses: number;
    deductions: { providentFund: number; esi: number; professionalTax: number; lwf: number; other: number };
    dateOfJoining: string;
    dateOfBirth: string;
    gender: string;
  }[];
  /** Wage floor / minimums for state, if any. */
  minimumWage: { skilled: number; unskilled: number };
}

export interface AdvanceTaxConfig extends AnalysisBaseConfig {
  /** FY. */
  fy: string;
  /** Assessee type. */
  assesseeType: "individual" | "company" | "firm" | "llp";
  /** Estimated total income for the year (major units). */
  estimatedTotalIncome: number;
  /** Method: "slab-snapshot" or "yearly-projection". */
  method: "slab-snapshot" | "yearly-projection";
  /** Actual income by instalment date if projection method. */
  incomeByInstalment?: { dueDate: string; incomeUpToDate: number }[];
  /** Prepaid taxes already paid/adjusted. */
  prepaidTax: { advanceTaxPaid: number; tds: number; tcs: number };
  /** Whether liability exceeds threshold for advance-tax. */
  liabilityExceedsThreshold: boolean;
}

export interface AuditFieldConfig extends AnalysisBaseConfig {
  /** Entity/firm name. */
  engagementName: string;
  /** Financial year end. */
  yearEnd: string;
  /** materiality inputs. */
  materiality: {
    benchmark: number;
    benchmarkBase: string;
    performanceMaterialityPct: number;
    ppmThreshold: number;
  };
  /** Population sizes for sampling. */
  populations: { stratum: string; bookValue: number; items: number }[];
  /** Risk assessments per area. */
  riskRatings: { area: string; inherentRisk: string; controlRisk: string; detectionRiskTarget: string }[];
  /** Desired confidence / tolerable misstatement for MUS. */
  mus: { tolerableMisstatement: number; expectedErrors: number; confidence: number };
  /** Analytical review expectations. */
  analyticalExpectations: { account: string; priorYear: number; expectedChangePct: number; actualCurrent: number }[];
}

export interface IndAsConfig extends AnalysisBaseConfig {
  /** FY. */
  fy: string;
  /** Whether Ind AS applicable (entity size/listing etc.). */
  indAsApplicable: boolean;
  /** List of Ind AS standards relevant, e.g. ["Ind AS 1", "Ind AS 115", "Ind AS 116", "Ind AS 109", "Ind AS 102", "Ind AS 107", "Ind AS 113"]. */
  standards: string[];
  /** Key judgments register. */
  judgments: { area: string; description: string; estimationUncertainty: boolean }[];
  /** Transition, if any. */
  transition: { date: string; method: string; openingAdjustment: number };
}

export interface EfilingConfig extends AnalysisBaseConfig {
  /** Form/scheme type. */
  formType: "itr" | "audit-report" | "gst" | "tds-statement" | "roc-form";
  /** Pre-submission data. */
  payload: Record<string, unknown>;
  /** Signing method. */
  signingMethod: "dsc" | "evc" | "etm";
  /** DSC details if applicable. */
  dsc: { user: string; certificateSerial: string } | null;
  /** Acknowledgement capture. */
  acknowledgement?: { ackNumber: string; date: string; status: string };
}

export interface PracticeManConfig extends AnalysisBaseConfig {
  /** Client/matter details for the workspace. */
  /** Firm-level practice operating system. Eng_-first, client-isolated, role-aware. */
  firm: {
    firmId: string;
    name: string;
    /** Firm-wide compliance calendar window (start/end) for rolling due-list views. */
    calendarWindowStart: string;
    calendarWindowEnd: string;
  };
  /** Client registry — the identity every engagement, deadline, document and assignment is scoped to. */
  clients: ClientConfig[];
  /** Engagements / matters across the firm. */
  engagements: EngagementConfig[];
  /** Firm-level analytics scope — which roll-ups to surface. */
  analytics: FirmAnalyticsScope;
}

// ---------------------------------------------------------------------------
// Practice management — firm-wide operating system types
// ---------------------------------------------------------------------------

/**
 * Firm-OS access role for a client/document in the practice-management workspace.
 *
 * Distinct from the engagement permission ladder (`PracticeRole`, further down):
 * that one carries the PARTNER/MANAGER/… rank used to gate sign-off, whereas this
 * is the coarse partner/reviewer/assistant allow-list stored on each client and
 * document for client-wise isolation. Kept separate so the two role models can
 * evolve without one silently widening the other's permissions.
 */
export type PracticeAccessRole = "partner" | "reviewer" | "assistant";

/** Engagement lifecycle stage. */
export type EngagementStatus = "entered" | "scoped" | "in-progress" | "under-review" | "completed" | "archived";

/** Workpaper lifecycle state including rework. */
export type WorkpaperStatus = "draft" | "in-review" | "rework" | "approved" | "signed-off";

/** Who a workpaper or assignment is currently pending on. */
export type WorkpaperOwnerType = "partner" | "reviewer" | "assistant" | "unassigned";

/** Document lifecycle state. */
export type DocumentStatus = "draft" | "final" | "signed" | "superseded" | "retained";

/** A client / entity in the firm registry. Client-wise isolation is modelled here. */
export interface ClientConfig {
  clientId: string;
  /** Legal/client-facing name. */
  name: string;
  /** Statutory identifiers (PAN/CIN/GSTIN) — optional, supplied per client. */
  identifiers: { pan?: string | null; cin?: string | null; gstin?: string | null };
  /** Client-specific working-paper template ids (reusable families). */
  workpaperTemplateIds: string[];
  /** Client contact for the communication log. */
  primaryContact: string;
  /** Which roles may access this client's data (client-wise permissions). */
  allowedRoles: PracticeAccessRole[];
}

/** One engagement / matter under a client. */
export interface EngagementConfig {
  engagementId: string;
  clientId: string;
  matter: string;
  /** Engagement status lifecycle. */
  status: EngagementStatus;
  /** Scope narrative. */
  scope: string;
  /** Engagement financial year / period label. */
  periodLabel: string;
  /** Lead partner responsible. */
  leadPartner: string;
  /** Reviewers assigned. */
  reviewers: string[];
  /** Fee budget in major units (INR). */
  feeBudget: number;
  /** Fee actually billed to date, in major units (INR). */
  feeBilled: number;
  /** Fee actually realised to date, in major units (INR). */
  feeRealised: number;
  /** Time recorded against the engagement, in hours (major units). */
  timeRecordedHours: number;
  /** Client communication log entries. */
  communications: { date: string; from: string; to: string; subject: string; note: string }[];
  /** Phases / workstreams with budget vs actual. */
  phases: EngagementPhaseConfig[];
  /** Deadlines scoped to this engagement (and its entities). */
  deadlines: EngagementDeadlineConfig[];
  /** Working papers under this engagement. */
  workpapers: WorkpaperConfig[];
  /** Documents under this engagement. */
  documents: DocumentConfig[];
}

/** A phase / workstream with budget vs actual. */
export interface EngagementPhaseConfig {
  phaseId: string;
  name: string;
  budgetHours: number;
  actualHours: number;
  feeBudget: number;
  feeBilled: number;
  status: "not-started" | "in-progress" | "completed";
}

/** A deadline scoped to an engagement (and optionally an entity). */
export interface EngagementDeadlineConfig {
  deadlineId: string;
  label: string;
  dueDate: string;
  /** Optional statutory/entity tag (e.g. "entity-1"). */
  entityTag?: string | null;
  /** Dependency deadline ids — this one should not slip ahead of these. */
  dependsOn: string[];
  /** Current status, computed by the engine against the calendar window. */
  status: "upcoming" | "due" | "overdue" | "completed" | "escalated";
  /** Person currently responsible. */
  owner: string;
  /** Escalation note when status becomes escalated. */
  escalationNote?: string | null;
}

/** A working paper under an engagement. */
export interface WorkpaperConfig {
  workpaperId: string;
  /** Firm-wide working-paper number (e.g. "WP-2025-0417"). */
  workpaperNumber: string;
  title: string;
  /** Reusable working-paper family this belongs to. */
  familyId?: string | null;
  /** Client-specific template id used for this paper (client templates). */
  templateId?: string | null;
  status: WorkpaperStatus;
  /** Current owner by role type. */
  ownerType: WorkpaperOwnerType;
  ownerUserId: string;
  /** Cross-references to other workpaper numbers. */
  crossReferences: string[];
  dueDate: string;
  /** Review / rework / sign-off history. */
  reviewHistory: WorkpaperReviewEvent[];
}

/** One review / rework / sign-off event on a workpaper. */
export interface WorkpaperReviewEvent {
  date: string;
  action: "submitted-for-review" | "review-note" | "rework" | "approved" | "signed-off";
  byUserId: string;
  note?: string | null;
}

/** A versioned document under an engagement. */
export interface DocumentConfig {
  documentId: string;
  name: string;
  type: string;
  /** Versioning — each saved state is a version. */
  version: number;
  /** Whether this is a working paper, final report, or signed copy. */
  documentClass: "working-paper" | "final-report" | "signed-copy" | "supporting";
  uploadedAt: string;
  ownerUserId: string;
  status: DocumentStatus;
  /** Retention rule applied. */
  retentionUntil: string | null;
  /** Client access control — which roles may view this document. */
  allowedRoles: PracticeAccessRole[];
}

/** Which firm-level roll-ups the caller wants. */
export interface FirmAnalyticsScope {
  /** Include realisation roll-up. */
  realisation: boolean;
  /** Include pipeline roll-up. */
  pipeline: boolean;
  /** Include overdue work roll-up. */
  overdue: boolean;
  /** Include compliance due list across clients. */
  complianceDueList: boolean;
  /** Include staffing load roll-up. */
  staffingLoad: boolean;
}

/** Client result (engine output). */
export interface ClientResult {
  clientId: string;
  name: string;
  engagementCount: number;
  activeEngagementCount: number;
  overdueDeadlineCount: number;
  unsignedDocumentCount: number;
}

/** Engagement-level result (engine output). */
export interface EngagementResult {
  engagementId: string;
  clientId: string;
  matter: string;
  status: EngagementStatus;
  scope: string;
  periodLabel: string;
  leadPartner: string;
  reviewers: string[];
  feeBudget: number;
  feeBilled: number;
  feeRealised: number;
  realisationPct: number;
  timeRecordedHours: number;
  timeBudgetVariancePct: number;
  phaseBreakdown: EngagementPhaseResult[];
  pendingCommunications: number;
  openWorkpaperCount: number;
  unsignedDocumentCount: number;
  deadlines: DeadlineResult[];
  /** Working papers under this engagement, with review/rework/sign-off history intact. */
  workpapers: WorkpaperConfig[];
  /** Documents under this engagement, keeping ownership, versioning and access roles. */
  documents: DocumentConfig[];
  warnings: string[];
}

/** Phase result with budget vs actual. */
export interface EngagementPhaseResult {
  phaseId: string;
  name: string;
  budgetHours: number;
  actualHours: number;
  hoursVariancePct: number;
  feeBudget: number;
  feeBilled: number;
  feeVariancePct: number;
  status: "not-started" | "in-progress" | "completed";
}

/** Deadline result with dependency awareness. */
export interface DeadlineResult {
  deadlineId: string;
  label: string;
  dueDate: string;
  entityTag?: string | null;
  status: "upcoming" | "due" | "overdue" | "completed" | "escalated";
  owner: string;
  dependsOn: string[];
  dependentCount: number;
  escalationNote?: string | null;
}

/** Firm-level analytics roll-up (engine output). */
export interface FirmAnalyticsResult {
  periodStart: string;
  periodEnd: string;
  clientCount: number;
  engagementCount: number;
  realisation: RealisationRollup;
  pipeline: PipelineRollup;
  overdueWork: OverdueWorkRollup;
  complianceDueList: ComplianceDueListItem[];
  staffingLoad: StaffingLoadRollup;
}

/** Realisation roll-up across the firm. */
export interface RealisationRollup {
  totalFeeBudget: number;
  totalFeeBilled: number;
  totalFeeRealised: number;
  realisationPct: number;
  byStatus: { status: EngagementStatus; budget: number; billed: number; realised: number; realisationPct: number }[];
}

/** Pipeline roll-up across the firm. */
export interface PipelineRollup {
  totalPipeline: number;
  weightedPipeline: number;
  byStatus: { status: EngagementStatus; count: number; pipeline: number }[];
  inScopeCount: number;
  inProgressCount: number;
  underReviewCount: number;
}

/** Overdue work roll-up across the firm. */
export interface OverdueWorkRollup {
  overdueDeadlineCount: number;
  overdueEngagementCount: number;
  escalatedDeadlineCount: number;
  openWorkpaperCount: number;
  pendingReviewCount: number;
  unsignedDocumentCount: number;
  byClient: {
    clientId: string;
    name: string;
    overdueDeadlines: number;
    escalatedDeadlines: number;
    unsignedDocuments: number;
  }[];
}

/** One item on the firm-wide compliance due list. */
export interface ComplianceDueListItem {
  deadlineId: string;
  clientId: string;
  clientName: string;
  engagementMatter: string;
  label: string;
  dueDate: string;
  status: "due" | "overdue" | "upcoming";
  owner: string;
  daysUntilDue: number;
}

/** Staffing load roll-up across the firm. */
export interface StaffingLoadRollup {
  totalTimeRecordedHours: number;
  byPerson: {
    userId: string;
    role: PracticeAccessRole;
    allocatedHours: number;
    engagementCount: number;
    reviewQueueCount: number;
  }[];
  reviewQueueByReviewer: { reviewerUserId: string; pendingWorkpaperCount: number; pendingDocumentCount: number }[];
}

export type AnalysisConfig =
  | ({ kind: "eda" } & AnalysisBaseConfig)
  | ({ kind: "trend" } & TrendConfig)
  | ({ kind: "kpi" } & KpiConfig)
  | ({ kind: "correlation" } & CorrelationConfig)
  | ({ kind: "distribution" } & DistributionConfig)
  | ({ kind: "forecast" } & ForecastConfig)
  | ({ kind: "variance" } & VarianceConfig)
  | ({ kind: "segmentation" } & SegmentationConfig)
  | ({ kind: "cohort" } & CohortConfig)
  | ({ kind: "funnel" } & FunnelConfig)
  | ({ kind: "abtest" } & AbTestConfig)
  | ({ kind: "automl" } & AutoMlConfig)
  | ({ kind: "arimax" } & ArimaxConfig)
  | ({ kind: "regression" } & RegressionConfig)
  | ({ kind: "dataquality" } & DataQualityConfig)
  | ({ kind: "accounting" } & AccountingConfig)
  | ({ kind: "syntheticcontrol" } & SyntheticControlConfig)
  | ({ kind: "uplift" } & UpliftConfig)
  | ({ kind: "sprt" } & SprtConfig)
  | ({ kind: "drift" } & DriftConfig)
  | ({ kind: "compliance" } & ComplianceConfig)
  | ({ kind: "fsanalysis" } & FsAnalysisConfig)
  | ({ kind: "fsratio" } & FsRatioConfig)
  | ({ kind: "taxaudit" } & TaxAuditConfig)
  | ({ kind: "compcal" } & CompCalConfig)
  | ({ kind: "gst" } & GstConfig)
  | ({ kind: "itr" } & ItrConfig)
  | ({ kind: "tds" } & TdsConfig)
  | ({ kind: "roc" } & RocConfig)
  | ({ kind: "payroll" } & PayrollConfig)
  | ({ kind: "advancetax" } & AdvanceTaxConfig)
  | ({ kind: "auditfield" } & AuditFieldConfig)
  | ({ kind: "indas" } & IndAsConfig)
  | ({ kind: "efiling" } & EfilingConfig)
  | ({ kind: "practiceman" } & PracticeManConfig)
  | ({ kind: "whatif" } & WhatIfConfig)
  | ({ kind: "did" } & DidConfig)
  | ({ kind: "survival" } & SurvivalConfig)
  | ({ kind: "bayesian" } & BayesianConfig)
  | ({ kind: "sarima" } & SarimaConfig)
  | ({ kind: "distributed" } & DistributedConfig)
  | ({ kind: "streaming" } & StreamingConfig)
  | ({ kind: "deep-learning" } & DeepLearningConfig)
  | ({ kind: "nlp" } & NlpConfig)
  | ({ kind: "feature-store" } & FeatureStoreConfig)
  | ({ kind: "real-time-serving" } & RealTimeServingConfig)
  | ({ kind: "hte" } & HteConfig)
  | ({ kind: "iv-calculus" } & IvCalculusConfig)
  | ({ kind: "geospatial" } & GeospatialConfig) | ({ kind: "map" } & MapConfig);

export type Granularity = "day" | "week" | "month" | "quarter" | "year";

export interface ScopeInfo {
  rowsUsed: number;
  totalRows: number;
  sampled: boolean;
  filters: { column: string; value: string }[];
}

export interface MethodologyInfo {
  method: string;
  /** bullet points explaining exactly what was computed */
  steps: string[];
  assumptions: string[];
}

export interface AnalysisResult {
  kind: AnalysisKind;
  title: string;
  dataset: { name: string; id: string; rowCount: number; columns: string[] };
  scope: ScopeInfo;
  configHuman: string[];
  methodology: MethodologyInfo;
  qualityWarnings: string[];
  charts: ChartSpec[];
  tables?: TableSpec[];
  stats?: { label: string; value: string; hint?: string }[];
  /** deterministic quick findings surfaced on the result page */
  quickFindings?: string[];
}

export interface DiagnosticSummary {
  /** Whether an anomaly was detected. */
  hasAnomaly: boolean;
  /** The detected root cause category, if any. */
  causeCategory:
    "data_quality" | "missing_values" | "outlier" | "distribution" | "statistical" | "business_rule" | null;
  /** Human-readable description of the issue. */
  description: string;
  /** Number of contributing rows analyzed. */
  sampleSize: number;
  /** Total rows the metric was computed over. */
  totalRows: number;
  /** Confidence in the diagnosis (0–1). */
  confidence: number;
}

export interface AnalysisResult {
  kind: AnalysisKind;
  title: string;
  dataset: { name: string; id: string; rowCount: number; columns: string[] };
  scope: ScopeInfo;
  configHuman: string[];
  methodology: MethodologyInfo;
  qualityWarnings: string[];
  charts: ChartSpec[];
  tables?: TableSpec[];
  stats?: { label: string; value: string; hint?: string }[];
  /** deterministic quick findings surfaced on the result page */
  quickFindings?: string[];
  /** Diagnostic summary from diagnoseMetric, if available. */
  diagnosticSummary?: DiagnosticSummary | undefined;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export type InsightSeverity = "info" | "warning" | "critical";
export type Confidence = "calculated" | "inferred" | "recommendation";

export interface InsightInput {
  title: string;
  severity: InsightSeverity;
  metric?: string;
  observedChange?: string;
  evidence: string[];
  possibleCause?: string;
  businessImplication?: string;
  recommendedNextStep?: string;
  confidence: Confidence;
  extra?: Record<string, unknown>;
}

export interface InsightCard extends InsightInput {
  id?: string;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Advisor
// ---------------------------------------------------------------------------

export interface AdvisorEvidence {
  label: string;
  detail: string;
  confidence: Confidence;
}

export interface AdvisorResult {
  businessQuestion: string;
  executiveAnswer: string;
  evidence: AdvisorEvidence[];
  keyDrivers: string[];
  risks: string[];
  opportunities: string[];
  options: { title: string; detail: string; confidence: Confidence }[];
  recommendation: string;
  expectedImpact: string;
  nextActions: string[];
  /** Confidence map per structured section (calculated vs inferred). */
  confidenceFlags: { section: string; confidence: Confidence }[];
  /** Used dataset + columns + rows for transparency. */
  used: { datasetName: string; datasetId: string; rowsUsed: number; totalRows: number; sampled: boolean };
  methodologyNote: string;
  /**
   * Elite advisor diagnostics — every entry is computed from the dataset
   * (see lib/engine/advisor-analysis.ts). Optional so older stored results
   * without these sections still render.
   */
  diagnostics?: {
    /** Primary metric the advisor analysed (name + headline stats). */
    metric: { name: string; total: number; mean: number; median: number; stddev: number; nonEmpty: number };
    /** Contribution of each group to the total and to the latest change. */
    decomposition: {
      dimension: string;
      dateCol: string | null;
      latestPeriodLabel: string | null;
      prevPeriodLabel: string | null;
      grandTotal: number;
      groups: {
        group: string;
        total: number;
        sharePct: number;
        rows: number;
        meanPerRow: number;
        latestChange: number | null;
        latestChangePct: number | null;
      }[];
    } | null;
    /** Trend diagnosis with Mann–Kendall test + backtested projection. */
    trend: {
      dateCol: string;
      granularity: Granularity;
      nPeriods: number;
      latest: number | null;
      previous: number | null;
      changePct: number | null;
      mannKendallP: number;
      mannKendallDirection: "increasing" | "decreasing" | "no trend";
      projection: {
        nextPeriod: number;
        method: string;
        mae: number;
        mape: number;
        folds: number;
        reliable: boolean;
      } | null;
    } | null;
    /** HHI concentration on the primary dimension. */
    concentration: {
      dimension: string;
      hhi: number;
      topSharePct: number;
      top3SharePct: number;
      levels: number;
      interpretation: string;
    } | null;
    /** Welch t-test between the top and bottom segments. */
    segmentTest: {
      segmentA: string;
      segmentB: string;
      meanA: number;
      meanB: number;
      diffPct: number;
      pValue: number;
      significant: boolean;
      nA: number;
      nB: number;
    } | null;
    /** Share of the metric total contributed by outlier rows. */
    outlierExposure: { outlierRows: number; totalSharePct: number | null; outlierThresholdHigh: number } | null;
    /** What could NOT be computed from this dataset, and why. */
    unavailable: string[];
  };
}

// ---------------------------------------------------------------------------
// Dashboards, reports, presentations
// ---------------------------------------------------------------------------

import type { PbiVisualKind, PbiVisualSpec } from "@/components/charts/pbi-visual";

export type { PbiVisualKind, PbiVisualSpec };

export interface DashboardWidget {
  id: string;
  type:
    "kpi" | "chart" | "table" | "text" | "insight" | "filter" | "recommendation" | "pivot" | "pbi-visual" | "slicer";
  title: string;
  w: number;
  h: number;
  x?: number;
  y?: number;
  /** References to produce this widget's content */
  datasetId?: string;
  analysisId?: string;
  insightId?: string;
  /** For chart widgets: inline chart spec snapshot */
  chart?: ChartSpec;
  /** For kpi widgets */
  kpi?: KpiCard;
  kpiKind?: "sum" | "mean" | "min" | "max" | "count";
  /** For table widgets */
  table?: TableSpec;
  /** For text widgets */
  content?: string;
  /** For insight widgets */
  insight?: InsightCard;
  /** For recommendation widgets */
  recommendation?: RecommendationWidget;
  /** For pivot widgets */
  pivot?: {
    rows: string[];
    columns: string[];
    values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
    onCellClick?: (rowValues: string[], columnValue: string) => void;
    /** Dataset the pivot reads from (fallback when the widget has no datasetId). */
    datasetId?: string;
  };
  /** For Power BI–style visual widgets (waterfall, sankey, pareto, …). */
  pbiVisual?: PbiVisualSpec;
  /** For pbiVisual kind "map": which boundary set the choropleth draws. */
  mapScope?: "us-states" | "countries";
  /** Dataset the widget was built on (label shown on canvas) */
  sourceDatasetName?: string;
  /**
   * Saved cross-filter selections (Power BI–style click-to-filter). Persisted
   * with the dashboard JSON so a filtered view survives reload; the live
   * selection state during editing lives in the builder component.
   */
  crossFilters?: { column: string; values: string[]; sourceWidgetId: string; sourceWidgetTitle?: string }[];
  /** For slicer widgets: the Power BI–style filter control configuration. */
  slicer?: SlicerSpec;
  /** Report-grade formatting (ROADMAP 3.4): conditional colors, reference
   *  lines, data labels — the fields real report authors reach for. */
  format?: VisualFormat;
  /** Field well: re-bind this widget to different columns of its dataset
   *  (Power BI "drag fields here"). */
  fields?: FieldWell;
  /** Drill-down hierarchy: ordered levels the widget's category axis can
   *  drill through (Power BI "Add hierarchy to drill"). */
  hierarchy?: DrillHierarchy;
  /** Tooltip page: a named report page shown as this widget's hover tooltip. */
  tooltipPageId?: string;
}

/** Power BI field well: the columns a visual is bound to (re-bindable). */
export interface FieldWell {
  /** Category axis (x) column names, in order — the drill path when combined with a hierarchy. */
  axis?: string[];
  /** Measure/value columns (aggregated as their kpiKind when the widget aggregates). */
  values?: string[];
  /** Legend / small-multiples column. */
  legend?: string;
}

/** Power BI drill hierarchy: named, ordered levels over dataset columns. */
export interface DrillHierarchy {
  name: string;
  /** Ordered levels, e.g. ["Country", "State", "City"]. */
  levels: string[];
}

/**
 * A Power BI–style report page: one canvas of widgets. Page 0 mirrors the
 * dashboard's legacy `widgets` array so pre-pages dashboards upgrade in place.
 */
export interface ReportPage {
  id: string;
  name: string;
  widgets: DashboardWidget[];
  /** Page-level slicers/filters that apply to every visual on the page. */
  crossFilters?: DashboardWidget["crossFilters"];
}

/** A named view state: one click recalls a saved filter combination. */
export interface ReportBookmark {
  id: string;
  name: string;
  pageId?: string;
  description?: string;
  filters: { column: string; values: string[]; sourceWidgetId: string; sourceWidgetTitle?: string }[];
  capturedAt: string;
}

/**
 * Power BI–style report theme — the honest subset the renderers can honor.
 * `palette` feeds every chart's series colors; `dataLabels` turns labels on
 * globally; background/foreground tint the canvas.
 */
export interface ReportTheme {
  name: string;
  background: string;
  foreground: string;
  palette: string[];
  dataLabels: boolean;
}

/**
 * Power BI–style slicer configuration (the "filter" widget, made real).
 * `values` are the distinct items of the column in the widget's stored
 * snapshot — computed when the slicer is added, never fabricated.
 */
export interface SlicerSpec {
  /** The dashboard column / dimension this slicer filters (chart x-axis label, table column label or the widget title). */
  column: string;
  /** Distinct values offered (from the source widget's real snapshot). */
  values: string[];
  /** How the value list is presented. Default "list". */
  style?: "list" | "dropdown";
  /** Whether several values can be selected at once (Power BI multi-select). Default true. */
  multiSelect?: boolean;
}

/**
 * Report-grade per-widget formatting (Power BI "Format your visual" pane,
 * honest subset — everything here is renderable by the ECharts suite).
 */
export interface VisualFormat {
  /** Always show data labels on bars/slices/points (default: off, like Power BI). */
  dataLabels?: boolean;
  /** Draw a horizontal reference line at a constant value. */
  referenceLine?: { value: number; label?: string; color?: string };
  /** Override the default series colors (hex), aligned with the spec's series. */
  palette?: string[];
}

export interface RecommendationWidget {
  text: string;
  nextSteps: string[];
  priority: InsightSeverity;
}

export type ReportSectionSourceKind = "dataset" | "profile" | "analysis" | "insight" | "manual" | "awaiting";

/**
 * Provenance of a report section — which real, stored artifact the section's
 * content was computed from. `awaiting` means the section is honest about not
 * having evidence yet; `manual` means it is editorial/product boilerplate that
 * makes no data claims. This is what guarantees a report never fabricates.
 */
export interface ReportSectionSource {
  kind: ReportSectionSourceKind;
  /** Display label of the source artifact (dataset name, analysis/insight title…). */
  label?: string;
  /** Stable id of the source artifact (dataset/analysis/insight) when known. */
  id?: string;
}

export interface ReportSection {
  id: string;
  heading: string;
  kind: "text" | "chart" | "insight" | "table";
  content: string; // markdown-ish body text
  chart?: ChartSpec;
  insight?: InsightCard;
  table?: TableSpec;
  chartTitle?: string;
  /** Provenance — which real, stored artifact produced this section's content. */
  source?: ReportSectionSource;
}

export interface PresentationSlide {
  id: string;
  title: string;
  layout: "title" | "bullets" | "split" | "chart" | "quote" | "insight";
  bullets: string[];
  chart?: ChartSpec;
  insight?: InsightCard;
  notes?: string;
  accent?: string;
}

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  timezone?: string;
  numberFormat: NumberFormatSetting;
  dateFormat?: string;
  aiDemoMode: boolean;
  /** Which notification categories create in-app alerts. Empty/missing = all on. */
  notificationTypes?: string[];
}

/**
 * CA practice role on one engagement. This is the permission ladder a CA firm
 * actually uses; it is layered over the underlying ProjectRole space so the
 * rest of the app keeps working (see lib/server/engagement.ts).
 *
 *   PARTNER   — full control, can sign off; maps to ProjectRole OWNER.
 *   MANAGER   — manages the engagement, can review and sign off.
 *   REVIEWER  — reviews work but does not sign off on client data.
 *   SENIOR    — prepares work; may review juniors' drafts.
 *   ASSISTANT — prepares work under supervision.
 *   AUDITOR   — read-only, for firm-level or external audit access.
 */
export type PracticeRole = "PARTNER" | "MANAGER" | "REVIEWER" | "SENIOR" | "ASSISTANT" | "AUDITOR";

/** Working-paper lifecycle (SA 230). */
export type WorkingPaperStatus = "DRAFT" | "IN_REVIEW" | "REVIEWED" | "SIGNED_OFF" | "ARCHIVED";

/** Client-data change request lifecycle. */
export type ChangeRequestState =
  "DRAFT" | "REQUESTED" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "REJECTED" | "IMPLEMENTED" | "SUPERSEDED";

/** Confidentiality label for a client silo or an individual artifact. */
export type DataClassification = "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

/** Engagement-scoped purposes for which a client can give (or refuse) consent. */
export type ClientConsentPurpose = "engagement" | "statutory-filing" | "cross-border-transfer" | "product-improvement";

/**
 * Firm-wide privacy / retention posture. Stored under Organization.settings.privacy.
 * Every field has a safe default (redact by default, require consent, no forced
 * retention) so a legacy firm that never opens the panel is compliant by default.
 */
export interface OrganizationPrivacySettings {
  /** Redact PAN/GSTIN/CIN/DIN/Aadhaar/bank identifiers unless the caller may see them in full. */
  panRedactionDefault: boolean;
  /** Persist full change diffs in the ledger for partner/manager roles. */
  fullDiffLoggingDefault: boolean;
  /** Require an explicit client consent before a taxpayer-data export. */
  taxpayerExportConsentRequired: boolean;
  /** Override the jurisdiction retention floor, in days. null = use the jurisdiction default. */
  retentionDays: number | null;
  /** Auto-archive engagements this many days after their last activity. null = off. */
  autoArchiveEngagementDays: number | null;
  /** Allow exports to a jurisdiction outside the engagement's approved set. Default false. */
  crossBorderTransferAllowed: boolean;
  /** Require a ClientConsent row (cross-border-transfer purpose) for cross-border exports. */
  requireClientConsentForExport: boolean;
}

/**
 * Organization (firm) settings. Stored as JSON on Organization.settings.
 * Migration is additive (nullable) so legacy workspaces are untouched.
 */
export interface OrganizationSettings {
  billingEmail?: string;
  /** Audit-trail retention policy override (days). Defaults to the workspace default. */
  auditRetentionDays?: number;
  /** Firm-wide privacy / retention posture (see OrganizationPrivacySettings). */
  privacy?: Partial<OrganizationPrivacySettings>;
}

export type NumberFormatSetting = "comma" | "dot" | "plain";

export const NOTIFICATION_TYPES = ["anomaly", "data-quality", "analysis", "report", "dashboard", "system"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  anomaly: "Anomalies detected in your data",
  "data-quality": "Data quality issues found",
  analysis: "Analyses and insights completed",
  report: "Reports and exports ready",
  dashboard: "Dashboard activity",
  system: "System and account notices",
};

export const NOTIFICATION_TYPE_SHORT: Record<NotificationType, string> = {
  anomaly: "Anomalies",
  "data-quality": "Data quality",
  analysis: "Analyses & insights",
  report: "Reports",
  dashboard: "Dashboards",
  system: "System",
};

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  timezone: "UTC",
  numberFormat: "comma",
  dateFormat: "medium",
  aiDemoMode: true,
  notificationTypes: [...NOTIFICATION_TYPES],
};

export const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export const DATE_FORMAT_OPTIONS = [
  { value: "short", label: "2026-01-05 (ISO)" },
  { value: "medium", label: "Jan 5, 2026" },
  { value: "long", label: "January 5, 2026" },
] as const;

// ---------------------------------------------------------------------------
// Misc shared types
// ---------------------------------------------------------------------------

export const ANALYSIS_KIND_LABELS: Record<AnalysisKind, string> = {
  eda: "Exploratory data analysis",
  trend: "Trend over time",
  kpi: "Key performance indicators",
  correlation: "Correlation analysis",
  distribution: "Distribution analysis",
  forecast: "Forecast",
  variance: "Variance by group",
  segmentation: "Segmentation (clustering)",
  cohort: "Cohort retention",
  funnel: "Funnel analysis",
  whatif: "What-if simulation",
  abtest: "A/B test (two-proportion)",
  automl: "AutoML model selection",
  arimax: "Forecast with drivers (ARIMAX)",
  regression: "Group comparison & significance",
  dataquality: "Data contract check",
  accounting: "Accounting statements",
  syntheticcontrol: "Synthetic control (causal)",
  uplift: "Uplift / treatment effect",
  sprt: "Sequential A/B test (SPRT)",
  drift: "Data drift (PSI)",
  compliance: "GST · TDS · audit sample",
  fsanalysis:
    "Financial statement analysis: common-size (vertical) and horizontal (year-over-year) analysis across the income statement, balance sheet and cash-flow statement — every line as a share of the right base and as an absolute/percentage change versus the prior period.",
  fsratio:
    "Financial ratio analysis: liquidity, solvency, profitability, efficiency, turnover, working-capital and cash-flow ratios over statement line inputs, with a peer-benchmark readout.",
  taxaudit:
    "Tax-audit determinations under the Indian Income-tax Act: whether S.44AB book-audit applies based on turnover/gross-receipts and business type, presumptive-returns turnover inclusion rules, and the audit-trigger flags a reviewer checks before issuing a report.",
  compcal:
    "Compliance calendar: statutory filing due dates for GST (GSTR-1/3B, GSTR-9/9C), income-tax (ITR, advance-tax, audit reports), TDS/TCS (challans/statements), ROC/MCA (AOC-4, MGT-7, charges), professional tax and labour/statutory returns, with days-to-due and overdue flags.",
  gst: "GST computation and reconciliation: outward/inward supply ledger → GSTR-1 summary, GSTR-3B summary, ITC availability and the 105%/20%/5% caps, ITC reconciliation between 3B and 2A/2B, mismatch flags, and back-calculation of the payable liability.",
  itr: "Income-tax return computation and generation: slab/rate selection by FY and regime, rebate u/s 87A, deductions u/s 80C/80D/80E/80G/HRA/NDAY/others, agricultural income set-off, set-off and carry-forward of losses, Schedule AI interest adjustment, and form-type selection (ITR-1/2/3/4/5/6/7) with a reproducible computation summary.",
  tds: "TDS/TCS computation: per-section rate, threshold, time-of-deduction and deposit rules for the common sections (194A/194C/194J/194LA/194Q/194R/206C/206C(1H) etc.), aggregate-threshold carry-over, late-deduction/late-deposit interest u/s 201/234E, and the Form 24Q/26Q/27Q statement summary.",
  roc: "ROC/MCA compliance: company-type-specific annual filing framework — AOC-4 financial statements, MGT-7/7A annual return, charges filing (CHG-4/8), DIR-3 KYC, D&O declaration, late fees u/s 405/406 of the Companies Act and the due-date calendar by company type.",
  payroll:
    "Payroll + professional tax + labour: salary head-wise split (basic/DA/HRA/special/allowances), PF (EPF/EDLI/admin) and EPS computation, ESI computation, professional tax by state, gratuity/LWF/boiler-plate statutory estimates, and the take-home waterfall.",
  advancetax:
    "Advance tax / self-assessment: instalment schedule by FY (corporate vs non-corporate), slab-snapshot tax at each instalment date, estimated income/yearly-projection method, shortfall interest u/s 234B/234C, and self-assessment tax computation u/s 140A.",
  auditfield:
    "Audit fieldwork computations: materiality (overall + performance), tolerable misstatements, sample-size drivers, MUS/attribute-sample planning, analytical-procedure expectations, and working-paper summaries a fieldwork team can paste into the audit file.",
  indas:
    "Ind AS / accounting-policy judgments: Ind AS applicability thresholds, the policy-register scaffold, key judgment areas (revenue recognition, impairment, leases, construction contracts, financial instruments, inventory, provisions), transition-entry scaffolding and the disclosure checklist.",
  efiling:
    "E-filing submission + e-sign: pre-submission JSON/schema prep for return/audit forms, DSC vs EVC vs ETM selection matrix, the acknowledgement capture flow (ACK number), and the resubmission/error-correction journey.",
  practiceman:
    "Practice management: client/matter workspace scaffold, workpaper register, deadline/billing tracking, reviewer/sign-off state, document index and a firm-wide compliance calendar roll-up.",
  did: "Difference-in-differences (causal)",
  survival: "Survival analysis (Kaplan–Meier, Cox)",
  bayesian: "Bayesian regression / Gaussian process",
  sarima: "Seasonal forecast (SARIMA / SARIMAX)",
  // New advanced categories.
  distributed: "Distributed / big-data compute (Spark/Flink)",
  streaming: "Streaming data ingestion & real-time processing",
  "deep-learning": "Deep learning at scale (GPU training, XGBoost, PyTorch live)",
  nlp: "NLP / unstructured text / image / audio analysis",
  "feature-store": "Feature store query and management",
  "real-time-serving": "Real-time serving and low-latency predictions",
  hte: "Individual treatment effect / HTE beyond average uplift",
  "iv-calculus": "Advanced causal: IV / do-calculus for policy evaluation",
  geospatial: "Geospatial / advanced mapping and regional analysis",
  map: "Choropleth map description",
};

export const ANALYSIS_KIND_DESCRIPTIONS: Record<AnalysisKind, string> = {
  eda: "Overview of structure, data quality and per-column statistics.",
  trend: "How a metric evolves over time with period-over-period change.",
  kpi: "Current vs previous period totals, averages and extremes.",
  correlation: "Strength and direction of linear relationships between numeric columns.",
  distribution: "Histogram and box-plot statistics for a single column.",
  forecast:
    "Next-period projection from a real ETS/ARIMA model family (exponential smoothing + Box–Jenkins) — candidates are scored by AICc on your data, cross-checked with a walk-forward backtest, and the winner is projected with 95% prediction intervals.",
  variance: "How a metric differs across groups and periods.",
  segmentation: "Group rows into distinct clusters by similarity (k-means).",
  cohort: "Retention of entities across time buckets (e.g. customer cohorts).",
  funnel: "Conversion through sequential stages of a process.",
  abtest:
    "Two-proportion z-test with a 95% confidence interval, a Bayesian posterior probability that the treatment wins, and the assumptions each conclusion actually rests on.",
  automl:
    "Searches the algorithm space (ridge / logistic / trees / forest / gradient boosting / kNN / MLP) with cross-validation and reports the full leaderboard — including the candidates that lost, not just the winner.",
  arimax:
    "Dynamic regression: the metric is modelled against exogenous drivers with autocorrelated errors, fit by Cochrane–Orcutt. Unlike a plain trend forecast, it can explain *why* the series moves.",
  regression:
    "Compares two groups on a metric with Welch's t-test or the Mann–Whitney U test, plus effect size (Cohen's d / Cliff's delta) and a confidence interval — so a significant result can be judged for practical size.",
  dataquality:
    "Tests the dataset against a data contract: missing columns, type mismatches, nullability breaches, uniqueness, value ranges and allowed sets. The gate that runs before you trust any number downstream.",
  accounting:
    "Posts an uploaded voucher file to a double-entry ledger and produces a trial balance, profit & loss account, balance sheet and cash-flow statement. Every entry must balance to the paise — an unbalanced voucher is rejected, never repaired.",
  syntheticcontrol:
    "Estimates the causal effect of an intervention on one treated unit by building a weighted 'synthetic' version of it from untreated donors. The effect is the gap between what happened and what would have happened — the gold standard when randomisation is impossible.",
  uplift:
    "Finds which customers respond to an intervention rather than which respond anyway. Scores incremental impact per customer and ranks them, so a campaign targets persuadable customers instead of those who would convert regardless.",
  sprt: "Sequential A/B testing: a running likelihood ratio decides whether to ship, stop, or keep running, with error rates controlled exactly no matter how often you look — unlike repeated fixed-horizon p-values.",
  drift:
    "Population stability index between an earlier (reference) window and the current one, per column, with the Kolmogorov–Smirnov statistic for numeric columns. Answers whether a deployed model's inputs have shifted enough to invalidate it.",
  fsanalysis:
    "Common-size (vertical) and horizontal (year-over-year) analysis across the income statement, balance sheet and cash-flow statement: every line is expressed as a share of the right base and as an absolute/percentage change versus the prior period, so a reviewer can read structure and movement in one pass.",
  fsratio:
    "Liquidity, solvency, profitability, efficiency, turnover, working-capital and cash-flow ratios computed from statement-line inputs, with a peer-benchmark readout so a ratio is always interpreted against a reference, not on its own.",
  taxaudit:
    "Whether the Indian book-audit requirement under S.44AB is triggered for a business: gross turnover/gross receipts are compared against the limits for the entity type and business nature, presumptive-scheme turnover inclusions and exempt receipts are flagged, and the audit-decision checklist a reviewer signs off on is produced.",
  compcal:
    "A statutory filing calendar across GST (GSTR-1, GSTR-3B, GSTR-9/9C), income-tax (ITR, advance-tax instalments, audit reports under 44AB/44ADA/44AD), TDS/TCS (challans and statements), ROC/MCA (AOC-4, MGT-7, charges, DIR-3 KYC), professional tax and labour/statutory returns, with days-to-due and overdue flags inside the client window.",
  gst: "GST computation and reconciliation from an outward/inward supply ledger into a GSTR-1 summary, a GSTR-3B summary, ITC availability with the 105%/20%/5% caps, an ITC reconciliation between what was claimed in 3B and what is reflected in 2A/2B, mismatch flags, and a back-calculation of the net payable liability.",
  itr: "Income-tax return computation and generation for a selected FY and regime: slab/rate selection, rebate u/s 87A, Chapter VI-A deductions (80C/80D/80E/80G/80GG/80TTA/80TTB and others), HRA computation, agricultural-income set-off, loss set-off and carry-forward, Schedule AI interest adjustment, and form-type selection (ITR-1/2/3/4/5/6/7) with a reproducible computation summary.",
  tds: "TDS/TCS computation by section: rate, threshold, time of deduction and time of deposit for the common sections (194A, 194C, 194J, 194LA, 194Q, 194R, 206C and 206C(1H) and similar), aggregate-threshold carry-over across a financial year, late-deduction/late-deposit interest under 201 and 234E, and a Form 24Q/26Q/27Q statement summary.",
  roc: "ROC/MCA compliance framework for a company: company-type-specific annual filing obligations — AOC-4 financial statements, MGT-7/MGT-7A annual return, charges filing (CHG-4/CHG-8), DIR-3 KYC and the D&O declaration — with the due-date calendar by company type and the late-fee exposure under 405/406 of the Companies Act.",
  payroll:
    "Salary head-wise split (basic, DA, HRA, special allowance, other allowances) into a take-home waterfall with PF (employee + employer, EPF/EDLI/admin and EPS), ESI, professional tax by state, gratuity and labour-law boilerplate estimates (LWF, applicable minimum-wage checks), so statutory liability and net pay are derived from the same inputs.",
  advancetax:
    "Advance-tax and self-assessment computation for a FY: the instalment schedule (corporate vs non-corporate), the slab-snapshot or yearly-projection method, the tax snapshot at each instalment date, shortfall interest under 234B and 234C, and the self-assessment tax computation under 140A against tax already paid by way of TDS/TCS/advance-tax.",
  auditfield:
    "Audit fieldwork computations: overall and performance materiality from a benchmark and a performance-materiality percentage, tolerable misstatements, sample-size drivers, MUS/attribute-sample planning inputs, analytical-procedure expectation ranges, and working-paper summary lines a fieldwork team can paste into the audit file.",
  indas:
    "Ind AS / accounting-policy judgments: Ind AS applicability thresholds, the policy-register scaffold, key judgment areas (revenue under Ind AS 115, impairment under Ind AS 36, leases under Ind AS 116, construction contracts, financial instruments under Ind AS 109, inventory, provisions and contingencies), transition-entry scaffolding and the disclosure checklist.",
  efiling:
    "E-filing submission and e-sign workflow: pre-submission JSON/schema preparation for return, audit-report, GST and TDS/ROC forms, the DSC vs EVC vs ETM selection matrix, the acknowledgement-capture flow (ACK number, date, status) and the resubmission/error-correction journey, so submission is reproducible rather than ad-hoc.",
  practiceman:
    "Practice management scaffold: a client/matter workspace with a workpaper register (draft/review/approved states and owners), a deadline tracker (upcoming/due/overdue), billing-by-phase tracking, a document index, and a firm-wide compliance-calendar roll-up so a CA firm can run multiple engagements from one place.",
  compliance:
    "Indian statutory compliance over an uploaded invoice ledger: GST summary with the 20% ITC cap, TDS/TCS by section, statistical audit sampling with an accept/reject conclusion, and entity consolidation. Rates and thresholds are supplied by you, never assumed.",
  whatif:
    "Shifts a driver column by a chosen percentage and projects the impact on an outcome through the fitted linear model — the same projection model the in-app what-if tab uses, now running over any uploaded dataset.",
  did: "Difference-in-differences: estimates the causal effect of an intervention by comparing the change in the treated group against the change in a control group over the same window. Includes a placebo test one period before treatment, because a design that only works after the event cannot tell you why it works.",
  survival:
    "Time-to-event analysis with censoring: Kaplan–Meier curves with Greenwood variance, a log-rank comparison of two groups, and Cox proportional hazards regression reporting hazard ratios, Wald/LR inference and a concordance index.",
  bayesian:
    "Bayesian estimation instead of point estimates: a conjugate Normal–Inverse-Gamma posterior over regression coefficients (credible intervals, not just p-values), an optional random-walk Metropolis posterior sample, or an exact Gaussian-process regression with posterior predictive intervals.",
  sarima:
    "Seasonal ARIMA/SARIMAX: an AICc-scored grid of (p,q)×(P,Q) candidates fit by conditional least squares on the differenced series, with optional exogenous regressors and expanding-window rolling-origin cross-validation so the reported error is genuinely out-of-sample.",
  // New advanced categories.
  distributed: "Distributed / big-data compute using Spark / Flink-style parallel processing across clusters",
  streaming:
    "Streaming data ingestion & real-time processing — windowed aggregations, session semantics, and event-time processing",
  "deep-learning":
    "Deep learning at scale — GPU-accelerated training, XGBoost / PyTorch live inference, and distributed model training across workers",
  nlp: "NLP / unstructured text / image / audio analysis — topic modeling, sentiment, entity extraction, feature extraction from media",
  "feature-store":
    "Feature store query and management — online/offline feature retrieval, feature versioning, and feature lineage",
  "real-time-serving":
    "Real-time serving and low-latency predictions — model serving with sub-100ms response, A/B serving, and canary deployments",
  hte: "Individual treatment effect / HTE (heterogeneous treatment effects) beyond average uplift — causal forest, quantile treatment effects, and subgroup analysis",
  "iv-calculus":
    "Advanced causal: IV (instrumental variable) / do-calculus for policy evaluation — confounding adjustment, transportability, and principal stratification",
  geospatial:
    "Geospatial / advanced mapping and regional analysis — choropleth, hot-spot detection, spatial autocorrelation, and point-pattern analysis",
};

export const ROLE_OPTIONS = [
  "Data Scientist",
  "Data Analyst",
  "Business Analyst",
  "Consultant",
  "Founder",
  "Executive",
  "Other",
] as const;

export const GOAL_OPTIONS = [
  { value: "analyze", label: "Analyze business data" },
  { value: "dashboard", label: "Build dashboards" },
  { value: "forecast", label: "Forecast future performance" },
  { value: "reports", label: "Prepare executive reports" },
  { value: "research", label: "Perform research" },
  { value: "automate", label: "Automate recurring analytics" },
  { value: "presentations", label: "Create presentations" },
  { value: "decisions", label: "Support strategic decisions" },
] as const;

// ---------------------------------------------------------------------------
// Extended modules
// ---------------------------------------------------------------------------

export type ProjectRole = "OWNER" | "EDITOR" | "VIEWER" | "AUDITOR";
export type OrganizationRole = "OWNER" | "ADMIN" | "MEMBER" | "AUDITOR";

/** One notebook cell. Code cells run on the prototype kernel (see notebook-dsl). */
export type WidgetVariable = {
  name: string;
  type: "string" | "number" | "date" | "range";
  value: string | number | { min: string | number; max: string | number } | null;
  description?: string;
};

export type NotebookWidgetKind = "text" | "number" | "dropdown" | "date-range";

export type NotebookCellKind = "markdown" | "code" | "widget" | "sql" | "chart" | "table-display" | "pivot" | "map";

export interface SqlCellConfig {
  query: string;
  /** Dataset ID to run against (defaults to notebook's default dataset). */
  datasetId?: string;
  /** Whether to auto-materialize results as a new dataset. */
  materialize?: boolean;
}

export interface ChartCellConfig {
  /** Chart type: bar, line, scatter, donut, area, heatmap. */
  chartType: "bar" | "line" | "scatter" | "donut" | "area" | "heatmap" | "histogram";
  /** X-axis column name. */
  xColumn?: string;
  /** Y-axis column name(s). */
  yColumns: string[];
  /** Optional group-by column for series splitting. */
  groupBy?: string;
  /** Chart title override. */
  title?: string;
}

export interface TableDisplayConfig {
  /** Columns to show (empty = all). */
  columns?: string[];
  /** Maximum rows to display. */
  limit?: number;
  /** Conditional formatting rules. */
  conditionalFormatting?: ConditionalFormatRule[];
  /** Sort column. */
  sortBy?: string;
  /** Sort direction. */
  sortDir?: "asc" | "desc";
  /** Whether to show row numbers. */
  showRowNumbers?: boolean;
  /** Enable column filtering. */
  enableFilter?: boolean;
}

export interface ConditionalFormatRule {
  /** Column this rule applies to. */
  column: string;
  /** Comparison operator. */
  operator: "gt" | "lt" | "eq" | "gte" | "lte" | "between" | "contains" | "regex";
  /** Threshold value(s). */
  value: number | string;
  /** Upper bound for 'between' operator. */
  value2?: number | string;
  /** CSS color for the cell background. */
  color: string;
  /** Optional CSS color for text. */
  textColor?: string;
}

export interface PivotCellConfig {
  /** Row dimension columns. */
  rowColumns: string[];
  /** Column dimension columns. */
  columnColumns: string[];
  /** Value columns with aggregation. */
  values: { column: string; aggregation: "sum" | "count" | "avg" | "min" | "max" }[];
  /** Optional filter. */
  filters?: { column: string; values: string[] }[];
}

export interface MapCellConfig {
  /** Column containing latitude. */
  latColumn: string;
  /** Column containing longitude. */
  lngColumn: string;
  /** Column for bubble size (optional). */
  sizeColumn?: string;
  /** Column for color grouping (optional). */
  colorColumn?: string;
  /** Column for popup label (optional). */
  labelColumn?: string;
  /** Map style. */
  style?: "street" | "satellite" | "light" | "dark";
}

export interface NotebookCellDependency {
  /** Cell ID this cell depends on. */
  dependsOn: string;
  /** Variable name this cell reads from the dependency's output. */
  variable?: string;
}

export interface NotebookVersion {
  id: string;
  notebookId: string;
  version: number;
  cells: NotebookCell[];
  title: string;
  createdAt: string;
  authorName: string;
  /** Label for the snapshot (e.g. 'manual', 'auto', 'published'). */
  label?: string;
}

export type NotebookWidgetValue = string | number | { min: string | number; max: string | number } | null;

/**
 * Input-widget descriptor attached to a `widget` cell. The widget binds a
 * named variable; code cells reference it with `{{variable}}` and re-run
 * when the widget value changes (the Hex "data app" interaction model).
 */
export interface NotebookWidget {
  kind: NotebookWidgetKind;
  /** Bound variable name — referenced in code cells as {{variable}}. */
  variable: string;
  /** Human label shown next to the control. */
  label?: string;
  /** dropdown: allowed options. */
  options?: { value: string; label: string }[];
  /** number: bounds + step. */
  min?: number;
  max?: number;
  step?: number;
  /** Current value (persisted with the cell). */
  value?: NotebookWidgetValue;
}

export interface NotebookCell {
  id: string;
  kind: NotebookCellKind;
  content: string;
  output?: NotebookCellOutput | null;
  ranAt?: string | null;
  /** Input-widget descriptor when kind === "widget". */
  widget?: NotebookWidget;
  /** Named variables bound by input widgets in the same notebook (legacy). */
  widgetVariables?: Record<string, WidgetVariable>;
  /** SQL cell configuration (when kind === 'sql'). */
  sqlConfig?: SqlCellConfig;
  /** Chart cell configuration (when kind === 'chart'). */
  chartConfig?: ChartCellConfig;
  /** Table display configuration (when kind === 'table-display'). */
  tableDisplayConfig?: TableDisplayConfig;
  /** Pivot cell configuration (when kind === 'pivot'). */
  pivotConfig?: PivotCellConfig;
  /** Map cell configuration (when kind === 'map'). */
  mapConfig?: MapCellConfig;
  /** Cell dependencies for DAG execution. */
  dependencies?: NotebookCellDependency[];
  /** Output variable name — other cells can reference this cell's output. */
  outputVariable?: string;
}

/** Simple view model for a published notebook (public link / workspace view). */
export interface PublishedNotebook {
  id: string;
  title: string;
  datasetName: string | null;
  accessMode: "workspace" | "public";
  publishedAt: string | null;
  cells: NotebookCell[];
}

export type NotebookCellOutput = (
  | {
      type: "error";
      message: string;
    }
  | {
      type: "note";
      title: string;
      detail: string;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      image: { mimeType: "image/png"; data: string };
    }
  | {
      type: "table";
      title: string;
      columns: { key: string; label: string; format?: "number" | "pct" | "date" | "text" }[];
      rows: (string | number | null)[][];
    }
  | {
      type: "stats";
      title: string;
      stats: { label: string; value: string; hint?: string }[];
      histogram?: { bins: number[]; binCounts: number[] };
    }
  | { type: "chart"; title: string; chart: ChartSpec }
  | {
      type: "sql-result";
      title: string;
      columns: SqlColumn[];
      rows: SqlValue[][];
      rowCount: number;
      totalMatched: number;
      truncated: boolean;
      engine: string;
      note: string;
      executionMs: number;
    }
  | {
      type: "pivot-result";
      title: string;
      rowHeaders: string[];
      columnHeaders: string[];
      data: (string | number | null)[][];
    }
  | {
      type: "map-result";
      title: string;
      points: { lat: number; lng: number; label?: string; size?: number; color?: string }[];
    }
  | {
      type: "conditional-table";
      title: string;
      columns: { key: string; label: string; format?: "number" | "pct" | "date" | "text" }[];
      rows: (string | number | null)[][];
      cellStyles: Record<string, { bg?: string; color?: string }>;
    }
) & {
  /** Which engine produced this output. "pyodide-server" = real CPython in a server worker thread. */
  kernel?: "pyodide" | "dsl" | "pyodide-server";
};

/** Read-only SQL query result against a dataset's materialized rows. */
export interface SqlColumn {
  name: string;
  type: ColType;
}
export type SqlValue = string | number | boolean | null;

export interface SqlResultSet {
  columns: SqlColumn[];
  rows: SqlValue[][];
  rowCount: number; // rows returned (after LIMIT/cap)
  totalMatched: number; // rows that matched before the cap
  truncated: boolean;
  engine: "prototype-sql" | "duckdb" | "postgres-connector" | "snowflake-connector" | "bigquery-connector";
  note: string;
  executionMs: number;
}

export type ModelTask = "classification" | "regression" | "clustering";

/**
 * Train/validation/test generalization check. `gap` is the training metric
 * minus the WORST held-out metric, so a model that looks great only on rows it
 * memorized is surfaced rather than celebrated.
 */
export interface GeneralizationAssessment {
  primaryMetric: string;
  train: number;
  validation: number;
  test: number;
  gap: number;
  risk: "low" | "medium" | "high";
  explanation: string;
}

export interface ModelMetrics {
  algorithm: string;
  task: ModelTask;
  trainRows: number;
  featureCount: number;
  // regression
  r2?: number;
  rmse?: number;
  mae?: number;
  f1?: number;
  rocAuc?: number;
  testR2?: number;
  testRmse?: number;
  testMae?: number;
  testAccuracy?: number;
  testPrecision?: number;
  testRecall?: number;
  testF1?: number;
  testRocAuc?: number;
  // classification
  accuracy?: number;
  precision?: number;
  recall?: number;
  // validation split (the tuning hold-out)
  validationR2?: number;
  validationRmse?: number;
  validationMae?: number;
  validationAccuracy?: number;
  validationPrecision?: number;
  validationRecall?: number;
  validationF1?: number;
  validationRocAuc?: number;
  // clustering
  k?: number;
  inertia?: number;
  clusterSizes?: number[];
  /** present for supervised models; the UI leads with the held-out numbers */
  generalization?: GeneralizationAssessment;
  /** multiclass: per-class row counts (index-aligned with classList) */
  classCounts?: number[];
  /** multiclass: sorted class labels */
  classList?: string[];
  [key: string]: string | number | number[] | string[] | GeneralizationAssessment | undefined;
}

export interface ModelCard {
  task: ModelTask;
  algorithm: string;
  name: string;
  targetColumn?: string | null;
  features: string[];
  params: Record<string, number | string | boolean>;
  metrics: ModelMetrics;
  trainRows: number;
  createdAt: string;
  versionTag: string;
  weights: number[]; // model parameters (prototype format, see README)
  demoNote: string;
  featureMeans?: number[];
  featureStds?: number[];
  intercept?: number;
  /** clustering: centroids serialized as flat arrays */
  centroids?: number[][];
  /** classification: binarized label mapping */
  classMap?: { positive: string; negative: string };
  coefficients?: Record<string, number>;
  coefficientPValues?: Record<string, number>;
  split?: {
    method: "random";
    testRatio: number;
    trainRows: number;
    validationRows: number;
    testRows: number;
  };
  /** train-vs-held-out diagnostic; absent for unsupervised clustering */
  generalization?: GeneralizationAssessment;
  crossValidation?: {
    folds: { fold: number; trainRows: number; testRows: number; metrics: Record<string, number> }[];
    method: "k-fold";
  };
  featureImportance?: { feature: string; importance: number; method: string }[];
  residualDiagnostics?: {
    residuals: { predicted: number; actual: number; residual: number }[];
    normality: { statistic: number; pValue: number; passed: boolean };
    interpretation: string;
  };
  metadata: {
    engine:
      "prototype-trainer" | "hold-out-regression" | "hold-out-classification" | "k-means-clustering" | "cv-ml-trainer";
    exporter: "model-card-json"; // ONNX export arrives with the live kernel
    onnxNote: string;
    realComputation?: boolean;
  };
}

export interface WhatIfResult {
  driverColumn: string;
  outcomeColumn: string;
  pctChange: number; // signed perturbation (e.g. -5 or +10)
  beforeValue: number;
  afterValue: number;
  delta: number;
  deltaPct: number;
  direction: "increase" | "decrease";
  driverMean: number;
  model: {
    slope: number;
    intercept: number;
    rSquared: number;
    points: number;
    pValue: number;
    confidenceInterval: [number, number];
    /** Standard error of the slope — basis of the confidence interval. */
    slopeStandardError?: number;
    /** HC1 heteroskedasticity-robust slope standard error (MacKinnon–White). */
    slopeStandardErrorHC1?: number;
    /** Two-sided p-value for the slope from the HC1 standard error. */
    pValueHC1?: number;
    /** Control variables that actually entered the fitted model. */
    controls?: string[];
  };
  /**
   * Causal cross-check via propensity-score IPW (elite-causal engine). Present
   * when the dataset carries a binary treatment column: the driver is re-estimated
   * as an ATT-style weighted contrast robust to model misspecification of the
   * outcome — agreement with the OLS slope is evidence the projection is not an
   * artefact of the linear form.
   */
  causal?: {
    method: "propensity-ipw";
    treatmentColumn: string;
    /** IPW contrast estimate (treated-minus-control outcome difference). */
    estimate: number;
    standardError: number;
    ci95: { low: number; high: number };
    /** 1 − Φ(|z|) two-sided p-value for the weighted contrast. */
    pValue: number;
    /** IPW estimate expressed per driver unit (estimate / driver swing). */
    estimatePerUnit: number;
    /** |SMD| after weighting for every balance-checked covariate. */
    balanceMaxAbsSmdAfter: number;
    extremeWeights: number;
    n: number;
    nTreated: number;
    /** "agree" | "disagree" | "inconclusive" — OLS-vs-IPW verdict. */
    agreement: "agree" | "disagree" | "inconclusive";
    identifyingAssumption: string;
    warnings: string[];
  };
  /**
   * Present when the weak-signal path (OLS r² < 0.12) was rescued by a
   * cross-validated ridge fit: the projection uses an L2-regularized slope
   * whose alpha was selected out-of-fold on deterministic folds, and it is
   * reported ONLY when the regularized model beat the mean baseline out-of-fold
   * (cvR2 > 0). Still an associative projection — never a causal claim.
   */
  regularized?: {
    method: "ridge";
    /** Selected penalty (standardized-feature scale, deterministic grid). */
    alpha: number;
    /** Out-of-fold R² of the winning model vs the mean predictor baseline. */
    cvR2: number;
    /** Number of cross-validation folds used. */
    folds: number;
  };
  /** true when the data lacks signal — result is hypothetical, not causal. */
  fallback: boolean;
  narrative: string;
  confidenceNote: string;
  methodology: string[];
}

export interface PromptDraft {
  name: string;
  description?: string | null;
  template: string;
  isAdvisorTemplate?: boolean;
  chain?: string[];
}

export interface PromptItem {
  id: string;
  name: string;
  description: string | null;
  template: string;
  variables: string[];
  chain: string[];
  isAdvisorTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledReportView {
  id: string;
  name: string;
  cron: string;
  reportId: string | null;
  reportName: string | null;
  projectId: string | null;
  projectName: string | null;
  recipients: string[];
  enabled: boolean;
  nextRunAt: string | null; // computed
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunOutputUrl: string | null;
}

export interface ScheduledNotebookView {
  id: string;
  name: string;
  cron: string;
  notebookId: string;
  notebookName: string | null;
  projectId: string | null;
  projectName: string | null;
  recipients: string[];
  enabled: boolean;
  nextRunAt: string | null; // computed
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunOutputUrl: string | null;
}

export interface CommentThreadItem {
  id: string;
  authorName: string;
  authorId: string;
  body: string;
  createdAt: string;
  parentId: string | null;
}

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  isOwner: boolean;
  addedAt: string | null;
}

export interface ConnectorStatus {
  id: string;
  label: string;
  kind: "database" | "sheets" | "api" | "warehouse";
  configured: boolean;
  hint: string;
}

/** Safe client view of a workspace-owned connector (never contains config). */
export interface ConnectorView {
  id: string;
  name: string;
  kind: string;
  status: "untested" | "ok" | "error";
  lastTestedAt: string | null;
  lastError: string | null;
  syncEnabled: boolean;
  syncCron: string | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  importedDatasets: { id: string; name: string; sourceTable: string | null; rowCount: number }[];
  createdAt: string;
}

export interface ConnectorTableInfo {
  schema: string;
  name: string;
  columns: { name: string; dataType: string; nullable: boolean }[];
}

export interface ConnectorSample {
  columns: { name: string; type: string; colType: ColType }[];
  rows: SqlValue[][];
  rowCount: number;
}

export interface ConnectorChangeLog {
  previousRowCount: number;
  newRowCount: number;
  rowsAdded: number;
  rowsRemoved: number;
  comparedRows: number;
  truncated: boolean;
  note: string;
}

export interface ConnectorSyncRunView {
  id: string;
  datasetId: string;
  datasetName: string;
  tableName: string;
  status: "RUNNING" | "SUCCESS" | "ERROR";
  rowCount: number | null;
  changeLog: ConnectorChangeLog | null;
  error: string | null;
  triggeredBy: "manual" | "schedule";
  startedAt: string;
  finishedAt: string | null;
}

export interface FeatureFlags {
  pyodideUrl: string; // empty = demo DSL kernel only
  schedulerEnabled: boolean;
  trainingEnabled: boolean;
  collaborationEnabled: boolean;
  ssoEnabled: boolean;
  ssoProvider: string | null;
  /** SAML 2.0 SSO is configured end-to-end (SAML_METADATA_URL + SSO_ENABLED). */
  samlEnabled: boolean;
  connectors: ConnectorStatus[];
  /** Frozen-module switches (README "Product focus") — drive nav visibility and gated surfaces. */
  notebookEnabled: boolean;
  sqlLabEnabled: boolean;
  whatifEnabled: boolean;
  advisorEnabled: boolean;
  promptsEnabled: boolean;
  connectorsEnabled: boolean;
  /** Server-side dashboard/report/widget rendering. */
  renderingEnabled: boolean;
  /** LLM-backed features (copilot, NL→code, chart/query suggestions). */
  llmEnabled: boolean;
}

export const CONNECTOR_DEFS: Omit<ConnectorStatus, "configured">[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    kind: "database",
    hint: "Read-only connection string in CONNECTOR_POSTGRES_URL.",
  },
  {
    id: "snowflake",
    label: "Snowflake",
    kind: "warehouse",
    hint: "Read-only account + warehouse in CONNECTOR_SNOWFLAKE_URL.",
  },
  {
    id: "bigquery",
    label: "BigQuery",
    kind: "warehouse",
    hint: "Service-account JSON path in CONNECTOR_BIGQUERY_SERVICE_ACCOUNT.",
  },
  {
    id: "sheets",
    label: "Google Sheets",
    kind: "sheets",
    hint: "OAuth client id in CONNECTOR_GOOGLE_CLIENT_ID (read-only scope).",
  },
  {
    id: "rest",
    label: "REST API",
    kind: "api",
    hint: "Endpoint + bearer token are provided per import; nothing is stored.",
  },
];

export const CRON_PRESETS = [
  { label: "Daily at 09:00", cron: "0 9 * * *", desc: "Every day 09:00" },
  { label: "Weekdays at 08:30", cron: "30 8 * * 1-5", desc: "Mon–Fri 08:30" },
  { label: "Weekly (Mon 09:00)", cron: "0 9 * * 1", desc: "Every Monday 09:00" },
  { label: "Monthly (1st, 09:00)", cron: "0 9 1 * *", desc: "1st of every month 09:00" },
  { label: "Quarterly (1st, 07:00)", cron: "0 7 1 */3 *", desc: "1st of Jan/Apr/Jul/Oct 07:00" },
] as const;

// ---------------------------------------------------------------------------
// Deliverable assembly (firm-grade report formats, templates, signed versions)
// ---------------------------------------------------------------------------

/**
 * The catalogue of deliverables a CA practice issues. A format decides the
 * shape of the report; an engagement enables the formats it actually files.
 */
export type DeliverableFormatCode =
  | "FINANCIALS"
  | "PROFIT_LOSS"
  | "BALANCE_SHEET"
  | "NOTES"
  | "SCHEDULES"
  | "MGMT_LETTER"
  | "TAX_COMPUTATION"
  | "CERTIFICATE_44AB"
  | "CERTIFICATE_44ADA"
  | "CERTIFICATE_44AD"
  | "TAX_CONCLUSION"
  | "AUDIT_FINDINGS"
  | "MANAGING_AGENT_LETTER"
  | "LETTER_TO_CLIENT";

/** Applies to a whole set of formats (used for defaults + UI grouping). */
export type DeliverableFormatCategory = "FINANCIALS" | "TAX" | "AUDIT" | "CERTIFICATE" | "ADVISORY" | "LETTER";

/**
 * Deliverable lifecycle. A version is immutable once signed off; issuance is
 * the last step and is what the client actually receives.
 */
export type DeliverableStatus =
  "DRAFT" | "IN_REVIEW" | "REVIEWED" | "SIGNED_OFF" | "ISSUED" | "WITHDRAWN" | "SUPERSEDED" | "ARCHIVED";

/** A single revision can be published both to the client and to reviewers. */
export type DeliverableVariant = "CLIENT" | "REVIEWER";

/**
 * Structural role a part plays inside an assembled deliverable. The upper-case
 * members are the canonical spec kinds (report templates / server service); the
 * lower-case members are the part kinds the assembly engine actually emits
 * ("cover", "preamble", "body", "schedule", "note", "certificate", "letter",
 * "appendix", "clauses", "precedent", "extra", "workingPaperTrace") and are
 * what persisted versions store.
 */
export type DeliverablePartKind =
  | "COVER"
  | "REPORTING_LANGUAGE"
  | "PRIMARY_STATEMENT"
  | "NOTE"
  | "SCHEDULE"
  | "CERTIFICATE"
  | "TAX_COMPUTATION"
  | "FINDING"
  | "APPENDIX"
  | "SIGNATURE"
  | "cover"
  | "preamble"
  | "body"
  | "schedule"
  | "note"
  | "certificate"
  | "letter"
  | "appendix"
  | "clauses"
  | "precedent"
  | "extra"
  | "workingPaperTrace";

/** Part kinds the assembly engine emits (persisted versions / render output). */
export const DELIVERABLE_ENGINE_PART_KINDS: readonly DeliverablePartKind[] = [
  "cover",
  "preamble",
  "body",
  "schedule",
  "note",
  "certificate",
  "letter",
  "appendix",
  "clauses",
  "precedent",
  "extra",
  "workingPaperTrace",
] as const;

/** Where a part's content came from — the traceability backbone. */
export type DeliverableSourceKind = "MANUAL" | "WORKING_PAPER" | "ANALYSIS" | "DATASET" | "LEDGER" | "COMPUTED";

/** Append-only sign-off steps (each is an immutable event). */
export type DeliverableSignOffStep = "PREPARED" | "REVIEWED" | "SIGNED_OFF" | "ISSUED";

/** How a redaction rule rewrites the identifier it targets. */
export type RedactionPolicy = "MASKED" | "TOKENIZED" | "OMITTED";

/** A part specification inside a report template body. */
export interface ReportTemplatePartSpec {
  kind: DeliverablePartKind;
  heading: string;
  body: string;
  ref?: string;
}

/** Persisted template body: the ordered skeleton of an assembled deliverable. */
export interface ReportTemplateBody {
  parts: ReportTemplatePartSpec[];
  notation?: string;
}

/**
 * A Unique Document Identification Number as filed under the CA regulations
 * (an ICAI-style 21-character alphanumeric identifier). Generated when a
 * signed-off version is issued; every verification is recorded immutably.
 */
export interface UdinRecord {
  /** 21-character ICAI-style UDIN. */
  udin: string;
  /** When the UDIN was generated (=`issuedAt` of the version). */
  issuedAt: string;
  /** Practice member id that resolved and issued the document. */
  issuedById: string;
  /** Number of times the UDIN has been verified. */
  verifyCount: number;
  lastVerifiedAt: string | null;
  lastVerifiedById: string | null;
}

/** One side of a part-level comparison when diffing two versions. */
export interface DeliverableDiffSide {
  revision: number;
  kind: DeliverablePartKind | string;
  heading: string;
  ref: string | null;
  bodyHash: string;
}

/** A part whose content differs between two revisions. */
export interface DeliverableDiffChangedPart {
  at: "from" | "to";
  from: DeliverableDiffSide | null;
  to: DeliverableDiffSide | null;
}

/** Structural comparison of two revisions of the same deliverable. */
export interface DeliverableRevisionDiff {
  fromRevision: number;
  toRevision: number;
  identical: boolean;
  added: DeliverableDiffSide[];
  removed: DeliverableDiffSide[];
  changed: DeliverableDiffChangedPart[];
  orderChanged: boolean;
  bodyHashChanged: boolean;
}
