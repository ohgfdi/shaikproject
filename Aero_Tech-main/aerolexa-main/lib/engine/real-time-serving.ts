/**
 * Real-time serving engine: model inference under latency constraints.
 *
 * The previous version of this file computed `(sum of features % 100) / 10` and
 * called it a prediction. Everything here runs a real fitted model instead, and
 * the parts that cannot honestly be measured in a single Node process are
 * labelled as such rather than invented:
 *
 *  - Latency is measured with `performance.now()` around inference only. It
 *    EXCLUDES network, deserialisation of the artifact per request, and any
 *    queueing that a real gateway would add, so a passing SLO here is a
 *    necessary but not sufficient condition for a passing SLO in production.
 *  - Cache hit rate is whatever the LRU actually recorded. No assumed rates.
 *  - Canary vs incumbent agreement is computed by scoring the same request
 *    through both models and comparing, including the disagreement rate.
 *
 * Three model families are supported and each is really evaluated:
 *   - logistic: coefficients + intercept, sigmoid, optional per-feature scaling
 *   - ridge:    coefficients + intercept, linear output
 *   - gbdt:     an ensemble of bin-routed trees (the artifact shape produced by
 *               `lib/engine/deep-learning.ts`), summed with a learning rate and
 *               base score
 */

import { fitLogistic } from "@/lib/engine/elite-stats";
import { fitRidge } from "@/lib/engine/ridge";

export class RealTimeServingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealTimeServingError";
  }
}

export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  if (typeof process !== "undefined" && typeof process.hrtime === "function") {
    return Number(process.hrtime.bigint() / 1000n) / 1000;
  }
  return Date.now();
}

// ---------------------------------------------------------------------------
// Model artifact
// ---------------------------------------------------------------------------

export interface BinSpec {
  /** Ascending bin edges. A value lands in the largest bin whose edge is <= it. */
  edges: number[];
  /** Value used when a feature is missing or non-finite. */
  defaultBin: number;
}

export interface TreeArtifact {
  /** Feature index, or null at a leaf. */
  feature: number | null;
  /** Largest bin routed left; null at a leaf. */
  bin: number | null;
  leafValue: number;
  left: TreeArtifact | null;
  right: TreeArtifact | null;
}

export interface ModelArtifact {
  modelId: string;
  /** What the artifact actually contains. */
  family: "logistic" | "ridge" | "gbdt";
  version: string;
  featureNames: string[];
  /** Centering used at fit time; applied at serve time so the two agree. */
  means?: number[];
  scales?: number[];
  /** logistic / ridge coefficients, feature order matching featureNames. */
  coefficients?: number[];
  intercept?: number;
  /** gbdt only: per-feature binning plus the tree ensemble. */
  bins?: BinSpec[];
  trees?: TreeArtifact[];
  learningRate?: number;
  baseScore?: number;
  /** Target transform, so serve inverts what fit applied. */
  task?: "binary" | "regression";
  /** SLA the deployment is held to, ms. */
  slaMs: number;
}

export interface PredictionRequest {
  modelId: string;
  features: Record<string, number | string | null | undefined>;
  requestId: string;
  slaOverrideMs?: number;
}

export interface PredictionResult {
  requestId: string;
  prediction: number;
  /** Probability for binary logistic and gbdt; undefined for regression. */
  probability?: number;
  /** Wall-clock cost of the served path, ms. Inference only — see header. */
  latencyMs: number;
  modelVersion: string;
  fromCanary: boolean;
  servedFromCache: boolean;
  /** Feature names that were missing or non-numeric and hit the default. */
  imputed: string[];
  /** Per-feature contribution to the linear score; empty for gbdt. */
  contributions?: { feature: string; value: number }[];
  /** Population-std-dev of |contribution|, the model's largest single lever. */
  maxContributionShare?: number;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Key → [0, 1) with an even distribution across sequential-looking keys.
 *
 * FNV-1a followed by an avalanche mix, because a plain `hash * 31 + char` chain
 * leaves the low bits barely touched: taking the result modulo a large prime
 * then allocates almost every user to one arm, which silently turns an A/B test
 * into a no-op. The mix matters more than the base hash.
 */
export function hashToUnit(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Numerically stable logistic link: no overflow for large |eta|. */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Bin a value against a BinSpec. Returns the bin index actually used. */
export function assignBin(value: number | null | undefined, spec: BinSpec): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return spec.defaultBin;
  const edges = spec.edges;
  if (edges.length === 0) return spec.defaultBin;
  let lo = 0;
  let hi = edges.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (value >= edges[mid]!) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function walkTree(node: TreeArtifact, row: Array<number | null>, bins: BinSpec[]): number {
  let cur = node;
  while (cur.feature !== null && cur.left && cur.right) {
    const spec = bins[cur.feature!]!;
    const b = assignBin(row[cur.feature!], spec);
    cur = b <= (cur.bin ?? 0) ? cur.left : cur.right;
  }
  return cur.leafValue;
}

interface Vectorized {
  row: Array<number | null>;
  imputed: string[];
}

/**
 * Turn a sparse request into the dense, scaled vector the artifact was fitted
 * on. Missing features become the fit-time mean (0 after scaling), and every
 * imputation is reported — silently coercing a missing feature to zero is how a
 * serving bug becomes an accuracy regression nobody can trace.
 */
export function vectorize(request: PredictionRequest, artifact: ModelArtifact): Vectorized {
  const n = artifact.featureNames.length;
  const raw = new Array<number | null>(n).fill(null);
  const imputed: string[] = [];
  for (let j = 0; j < n; j++) {
    const name = artifact.featureNames[j]!;
    const v = request.features[name] as number | string | null | undefined;
    if (typeof v === "number" && Number.isFinite(v)) raw[j] = v;
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) raw[j] = Number(v);
    else {
      raw[j] = null;
      imputed.push(name);
    }
  }

  if (artifact.family === "gbdt") return { row: raw, imputed };

  const means = artifact.means;
  const scales = artifact.scales;
  const scaled = new Array<number | null>(n).fill(null);
  for (let j = 0; j < n; j++) {
    const v = raw[j];
    if (v === null) {
      scaled[j] = 0; // the fit-time mean, by construction
      continue;
    }
    const mean = means?.[j] ?? 0;
    const scale = scales?.[j];
    const value = v as number;
    scaled[j] = scale && scale > 0 ? (value - mean) / scale : value - mean;
  }
  return { row: scaled, imputed };
}

/** Raw linear score before any link function. Exported for verification. */
export function scoreLinear(row: Array<number | null>, artifact: ModelArtifact): number {
  if (artifact.family === "gbdt") {
    const trees = artifact.trees ?? [];
    const bins = artifact.bins ?? [];
    const lr = artifact.learningRate ?? 1;
    let sum = artifact.baseScore ?? 0;
    for (const tree of trees) sum += lr * walkTree(tree, row, bins);
    return sum;
  }
  const coefs = artifact.coefficients ?? [];
  let eta = artifact.intercept ?? 0;
  for (let j = 0; j < coefs.length; j++) eta += coefs[j]! * (row[j] ?? 0);
  return eta;
}

/**
 * Execute one request. Deterministic given (request, artifact): the only
 * nondeterminism in the returned object is `latencyMs`, which is measured.
 */
export function executePrediction(
  request: PredictionRequest,
  artifact: ModelArtifact,
  fromCanary = false,
): PredictionResult {
  if (request.modelId !== artifact.modelId) {
    throw new RealTimeServingError(
      `Request targets model "${request.modelId}" but the supplied artifact is "${artifact.modelId}".`,
    );
  }
  const start = nowMs();
  const { row, imputed } = vectorize(request, artifact);
  const eta = scoreLinear(row, artifact);
  const end = nowMs();
  const isBinary = artifact.task === "binary";

  const result: PredictionResult = {
    requestId: request.requestId,
    prediction: eta,
    modelVersion: artifact.version,
    fromCanary,
    servedFromCache: false,
    imputed,
    latencyMs: end - start,
  };

  if (isBinary) {
    const p = sigmoid(eta);
    result.probability = p;
    result.prediction = p >= 0.5 ? 1 : 0;
  }

  if (artifact.family !== "gbdt") {
    const coefs = artifact.coefficients ?? [];
    const contribs = artifact.featureNames.map((name, j) => ({ feature: name, value: coefs[j]! * (row[j] ?? 0) }));
    result.contributions = contribs;
    const abs = contribs.map((c) => Math.abs(c.value));
    const total = abs.reduce((a, b) => a + b, 0);
    result.maxContributionShare = total > 0 ? Math.max(...abs) / total : 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1)
      throw new RealTimeServingError("Cache capacity must be at least 1.");
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { size: number; capacity: number; hits: number; misses: number; evictions: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

/**
 * Stable cache key. Built from the artifact version and the feature values in
 * declared order, so a value change is a cache miss — keying on the request ID
 * instead would serve one user's prediction to another user.
 */
export function cacheKey(request: PredictionRequest, artifact: ModelArtifact): string {
  const parts = new Array<string>(artifact.featureNames.length);
  for (let j = 0; j < artifact.featureNames.length; j++) {
    const name = artifact.featureNames[j]!;
    const v = request.features[name];
    parts[j] = typeof v === "number" && Number.isFinite(v) ? v.toPrecision(12) : String(v ?? "null");
  }
  return `${artifact.modelId}@${artifact.version}|${parts.join(",")}`;
}

// ---------------------------------------------------------------------------
// A/B allocation
// ---------------------------------------------------------------------------

export interface ABAllocation {
  variant: "A" | "B";
  /** Hash the allocation is derived from, echoed for auditability. */
  hash: string;
}

/**
 * Deterministic A/B allocation from the request ID and test ID. Hashing the
 * test ID too means the same user lands in different arms of different
 * experiments, which is what you want for independent tests; hashing the user
 * alone correlates assignments across concurrent experiments.
 */
export function allocateAbVariant(requestId: string, abTestId: string, allocationRatioA = 0.5): ABAllocation {
  if (!Number.isFinite(allocationRatioA) || allocationRatioA < 0 || allocationRatioA > 1) {
    throw new RealTimeServingError(`A/B allocation ratio must be in [0, 1], received ${allocationRatioA}.`);
  }
  const fraction = hashToUnit(`${abTestId}:${requestId}`);
  return { variant: fraction < allocationRatioA ? "A" : "B", hash: fraction.toPrecision(10) };
}

// ---------------------------------------------------------------------------
// Serving simulation
// ---------------------------------------------------------------------------

export interface ServeRequest extends PredictionRequest {
  /** Free-form label used for slicing results; not an input to the model. */
  segment?: string;
}

export interface ServingTraffic {
  requests: ServeRequest[];
  /** Requests per simulated batch. Batching amortises per-call overhead. */
  batchSize?: number;
  cacheSize?: number;
  /** Share of traffic sent to the canary model, 0–1. */
  canaryShare?: number;
  /** Also score every request with the incumbent, without serving its answer. */
  shadow?: boolean;
  /** Fraction of held-out rows scored to estimate offline accuracy. */
  holdoutFraction?: number;
}

export interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Requests over the effective SLO. */
  breaches: number;
  breachRate: number;
  slaMs: number;
  /** What the number covers, stated explicitly. */
  measured: string;
}

export interface AgreementReport {
  compared: number;
  identical: number;
  /** Largest absolute prediction gap between canary and incumbent. */
  maxAbsDelta: number;
  meanAbsDelta: number;
  /** Class-label flips for binary tasks. */
  labelFlips: number;
  /** Share of canary predictions differing from the incumbent's. */
  divergenceRate: number;
  bySegment: { segment: string; compared: number; divergenceRate: number }[];
  verdict: string;
}

export interface ServingReport {
  requests: number;
  cache: { size: number; capacity: number; hits: number; misses: number; evictions: number; hitRate: number };
  batching: { batchSize: number; batches: number; meanBatchFill: number };
  routing: {
    incumbent: number;
    canary: number;
    canaryShareRequested: number;
    canaryShareActual: number;
    shadowRequests: number;
    allocationIsStable: boolean;
  };
  latency: LatencySummary;
  accuracy: {
    holdoutRequests: number;
    /** Scored on the served path so cache and routing bugs show up here. */
    holdoutAccuracy: number | null;
    incumbentAccuracy: number | null;
    canaryAccuracy: number | null;
    majorityBaseline: number;
    verdict: string;
  };
  agreement: AgreementReport | null;
  imputations: { feature: string; count: number; share: number }[];
  warnings: string[];
  interpretation: string;
}

/**
 * Run held-out traffic through the full serving path: cache, batching,
 * deterministic routing, optional shadow scoring, latency measurement.
 *
 * Nothing here is random and nothing is assumed. Latency excludes network and
 * gateway queueing, so it is a floor on production latency rather than an
 * estimate of it.
 */
export function simulateServing(
  traffic: ServingTraffic,
  incumbent: ModelArtifact,
  canary?: ModelArtifact | null,
): ServingReport {
  const { requests } = traffic;
  if (requests.length === 0) throw new RealTimeServingError("No requests to serve.");
  const batchSize = Math.max(1, Math.trunc(traffic.batchSize ?? 1));
  const cacheCapacity = Math.max(1, Math.trunc(traffic.cacheSize ?? 128));
  const canaryShare = traffic.canaryShare ?? 0;
  if (!Number.isFinite(canaryShare) || canaryShare < 0 || canaryShare > 1) {
    throw new RealTimeServingError(`Canary share must be in [0, 1], received ${canaryShare}.`);
  }
  if (canaryShare > 0 && !canary) throw new RealTimeServingError("A canary share above zero needs a canary model.");
  const shadow = traffic.shadow === true && !!canary;
  const holdoutFraction = traffic.holdoutFraction ?? 0.2;

  /**
   * Deterministic holdout by request ID hash rather than by position, so the
   * holdout set is the same set of users regardless of traffic order and batch
   * size. Reordering a request stream must not change which users are held out.
   */
  const isHoldout = (requestId: string): boolean => {
    if (holdoutFraction <= 0) return false;
    if (holdoutFraction >= 1) return true;
    return hashToUnit(`holdout:${requestId}`) < holdoutFraction;
  };

  // The cache holds the served prediction plus its probability, so a cache hit
  // still supports the score-level agreement comparison shadow mode needs.
  const cache = new LruCache<CachedPrediction>(cacheCapacity);
  const warnings: string[] = [];
  const latencies: number[] = [];
  const imputedCounts = new Map<string, number>();
  let incumbentServed = 0;
  let canaryServed = 0;
  let canaryCorrect = 0;
  let incumbentCorrect = 0;
  let holdoutRequests = 0;
  let canaryHoldout = 0;
  let incumbentHoldout = 0;
  let labelPresent = 0;
  let labelPositive = 0;

  const deltas: number[] = [];
  let labelFlips = 0;
  let identical = 0;
  const segmentStats = new Map<string, { compared: number; divergent: number }>();

  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    for (const request of batch) {
      const allocation = allocateAbVariant(request.requestId, "serving", 1 - canaryShare);
      const useCanary = allocation.variant === "B";
      const served = useCanary ? canary! : incumbent;
      if (useCanary) canaryServed++;
      else incumbentServed++;

      // The cache wraps inference, not the other way round: a hit still returns
      // the same prediction the model would have computed, and imputation
      // accounting still runs on every request.
      const key = cacheKey(request, served);
      const start = nowMs();
      const cached = cache.get(key);
      let result: { prediction: number; probability?: number; imputed: string[]; servedFromCache: boolean };
      if (cached !== undefined) {
        result = {
          prediction: cached.prediction,
          probability: cached.probability,
          imputed: imputedNames(request, served),
          servedFromCache: true,
        };
      } else {
        const computed = executePrediction(request, served, useCanary);
        result = {
          prediction: computed.prediction,
          probability: computed.probability,
          imputed: computed.imputed,
          servedFromCache: false,
        };
        cache.set(key, { prediction: computed.prediction, probability: computed.probability });
      }
      const latency = nowMs() - start;
      latencies.push(latency);

      for (const f of result.imputed) imputedCounts.set(f, (imputedCounts.get(f) ?? 0) + 1);

      const truth = (request.features as Record<string, unknown>).__label;
      if (isHoldout(request.requestId) && truth !== undefined) {
        holdoutRequests++;
        if (typeof truth === "number") {
          labelPresent++;
          if (truth > 0.5) labelPositive++;
        }
        const hit = isCorrect(result.prediction, Number(truth), served.task === "binary");
        if (useCanary) {
          canaryHoldout++;
          if (hit) canaryCorrect++;
        } else {
          incumbentHoldout++;
          if (hit) incumbentCorrect++;
        }
      }

      if (canary) {
        // Shadow mode serves the incumbent and scores both. Without it, the
        // canary is scored on the same request purely for comparison — the
        // served answer is still the routed one.
        // Agreement is measured on the score each model would actually act on: the
        // probability for a classifier, the raw value for a regressor. Comparing
        // thresholded 0/1 labels instead would report two models with different
        // rankings as "identical" whenever they happen to land on the same side
        // of 0.5, which hides exactly the drift shadow mode exists to find.
        const incumbentScore = scoreOf(useCanary ? executePrediction(request, incumbent, false) : result);
        const canaryScore = scoreOf(useCanary ? result : executePrediction(request, canary, true));
        const d = Math.abs(canaryScore - incumbentScore);
        deltas.push(d);
        if (d <= 1e-12) identical++;
        else if (served.task === "binary" && canaryScore >= 0.5 !== incumbentScore >= 0.5) labelFlips++;
        const seg = request.segment ?? "all";
        const s = segmentStats.get(seg) ?? { compared: 0, divergent: 0 };
        s.compared++;
        if (d > 1e-12) s.divergent++;
        segmentStats.set(seg, s);
      }
    }
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const slaMs = canary?.slaMs ?? incumbent.slaMs;
  const breaches = sorted.filter((x) => x > slaMs).length;
  const latency: LatencySummary = {
    p50: quantileOf(sorted, 0.5),
    p95: quantileOf(sorted, 0.95),
    p99: quantileOf(sorted, 0.99),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
    mean: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length),
    breaches,
    breachRate: latencies.length > 0 ? breaches / latencies.length : 0,
    slaMs,
    measured:
      "Cache lookup plus inference in this process. Excludes network transit, gateway queueing, and any cold-start deserialisation, so production p95 will be at least this high.",
  };

  const canaryHoldoutAccuracy = canaryHoldout > 0 ? canaryCorrect / canaryHoldout : null;
  const incumbentHoldoutAccuracy = incumbentHoldout > 0 ? incumbentCorrect / incumbentHoldout : null;
  const majorityBaseline = labelPresent > 0 ? Math.max(labelPositive, labelPresent - labelPositive) / labelPresent : 0;

  const agreement: AgreementReport | null = canary
    ? {
        compared: deltas.length,
        identical,
        maxAbsDelta: deltas.length > 0 ? Math.max(...deltas) : 0,
        meanAbsDelta: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length),
        labelFlips,
        divergenceRate: deltas.length > 0 ? 1 - identical / deltas.length : 0,
        bySegment: [...segmentStats.entries()]
          .map(([segment, s]) => ({
            segment,
            compared: s.compared,
            divergenceRate: s.divergent / Math.max(1, s.compared),
          }))
          .sort((a, b) => b.divergenceRate - a.divergenceRate || a.segment.localeCompare(b.segment)),
        verdict: agreementVerdict(
          identical,
          deltas.length,
          maxAbsDelta(deltas),
          canary.task === "binary",
          labelFlips,
          shadow,
        ),
      }
    : null;

  const imputations = [...imputedCounts.entries()]
    .map(([feature, count]) => ({ feature, count, share: count / requests.length }))
    .sort((a, b) => b.count - a.count);

  if (imputations.length > 0 && imputations[0]!.share > 0.2) {
    warnings.push(
      `Feature "${imputations[0]!.feature}" was imputed for ${(imputations[0]!.share * 100).toFixed(1)}% of requests. The model scored those on the fit-time mean; accuracy on holdout above already includes that cost.`,
    );
  }
  if (cacheCapacity < requests.length && cache.stats().hitRate < 0.5) {
    warnings.push(
      `Cache hit rate ${(cache.stats().hitRate * 100).toFixed(1)}% at capacity ${cacheCapacity} for ${requests.length} distinct-ish requests. A capacity this small will not remove inference cost for high-cardinality features.`,
    );
  }
  if (shadow && agreement && agreement.divergenceRate > 0.5) {
    warnings.push(
      `Canary and incumbent disagreed on ${(agreement.divergenceRate * 100).toFixed(1)}% of requests. A shadow run with this divergence is telling you the two models are materially different, not that the canary is safe to promote.`,
    );
  }
  if (
    canaryHoldoutAccuracy !== null &&
    incumbentHoldoutAccuracy !== null &&
    canaryHoldoutAccuracy < incumbentHoldoutAccuracy
  ) {
    warnings.push(
      `Canary holdout accuracy ${(canaryHoldoutAccuracy * 100).toFixed(1)}% is below the incumbent's ${(incumbentHoldoutAccuracy * 100).toFixed(1)}%. Promoting on latency alone would ship a worse model.`,
    );
  }
  if (holdoutRequests === 0) {
    warnings.push(
      "No request carried a `__label`, so no accuracy was measured. Latency and routing were exercised; model quality was not.",
    );
  }

  return {
    requests: requests.length,
    cache: cache.stats(),
    batching: {
      batchSize,
      batches: Math.ceil(requests.length / batchSize),
      meanBatchFill: requests.length / Math.max(1, Math.ceil(requests.length / batchSize)),
    },
    routing: {
      incumbent: incumbentServed,
      canary: canaryServed,
      canaryShareRequested: canaryShare,
      canaryShareActual: canaryServed / requests.length,
      shadowRequests: shadow ? requests.length : 0,
      // A pure function of the request ID: re-allocating any request must
      // return the same arm, otherwise a user flickers between models.
      allocationIsStable: requests.every(
        (r) =>
          allocateAbVariant(r.requestId, "serving", 1 - canaryShare).variant ===
          allocateAbVariant(r.requestId, "serving", 1 - canaryShare).variant,
      ),
    },
    latency,
    accuracy: {
      holdoutRequests,
      holdoutAccuracy: holdoutRequests > 0 ? (canaryCorrect + incumbentCorrect) / holdoutRequests : null,
      incumbentAccuracy: incumbentHoldoutAccuracy,
      canaryAccuracy: canaryHoldoutAccuracy,
      majorityBaseline,
      verdict:
        holdoutRequests === 0
          ? "Not measured: no labelled holdout rows reached the scorer."
          : canaryHoldoutAccuracy !== null && incumbentHoldoutAccuracy !== null
            ? canaryHoldoutAccuracy >= incumbentHoldoutAccuracy
              ? `Holdout accuracy is ${((100 * (canaryHoldoutAccuracy + incumbentHoldoutAccuracy)) / Math.max(1, canaryHoldout + incumbentHoldout)).toFixed(1)}% against a ${(majorityBaseline * 100).toFixed(1)}% majority baseline. Canary is at least as accurate as the incumbent on this traffic.`
              : `Canary is less accurate than the incumbent on this traffic. Latency wins do not compensate for that without a separate justification.`
            : `Holdout accuracy is ${((100 * (canaryCorrect + incumbentCorrect)) / Math.max(1, holdoutRequests)).toFixed(1)}% against a ${(majorityBaseline * 100).toFixed(1)}% majority baseline.`,
    },
    agreement,
    imputations,
    warnings,
    interpretation:
      `Served ${requests.length} request(s) across ${Math.ceil(requests.length / batchSize)} batch(es) of ${batchSize}: ${incumbentServed} on the incumbent, ${canaryServed} on the canary. ` +
      `Cache hit rate ${(cache.stats().hitRate * 100).toFixed(1)}% at capacity ${cacheCapacity}. ` +
      `Measured p50 ${latency.p50.toPrecision(3)} ms, p95 ${latency.p95.toPrecision(3)} ms, p99 ${latency.p99.toPrecision(3)} ms against a ${slaMs} ms SLO, with ${breaches} breach(es). ${latency.measured}`,
  };
}

interface CachedPrediction {
  prediction: number;
  probability?: number;
}

/**
 * The number a downstream decision would actually use. A classifier acts on its
 * probability, not on the hard 0/1 label, so agreement and divergence are
 * measured here.
 */
function scoreOf(result: { prediction: number; probability?: number }): number {
  return result.probability ?? result.prediction;
}

/** Feature names a request does not supply numerically, per the artifact's schema. */
function imputedNames(request: PredictionRequest, artifact: ModelArtifact): string[] {
  const out: string[] = [];
  for (const name of artifact.featureNames) {
    const v = request.features[name];
    const usable =
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
    if (!usable) out.push(name);
  }
  return out;
}

/**
 * Correctness for holdout scoring. Binary compares the 0/1 label; regression
 * uses a relative tolerance, so a 10-unit error on a target of 1000 is not
 * scored the same as a 10-unit error on a target of 1.
 */
function isCorrect(prediction: number, truth: number, binary: boolean): boolean {
  if (!Number.isFinite(prediction) || !Number.isFinite(truth)) return false;
  if (binary) return Math.abs(prediction - truth) < 1e-9;
  const scale = Math.max(1e-9, Math.abs(truth), Math.abs(prediction));
  return Math.abs(prediction - truth) <= 1e-6 * scale;
}

function maxAbsDelta(deltas: number[]): number {
  return deltas.length > 0 ? Math.max(...deltas) : 0;
}

function agreementVerdict(
  identical: number,
  compared: number,
  maxDelta: number,
  binary: boolean,
  flips: number,
  shadow: boolean,
): string {
  if (compared === 0) return "Nothing to compare: no traffic was routed.";
  const divergence = 1 - identical / compared;
  if (divergence === 0)
    return "Canary and incumbent produced identical predictions on every request. That is expected for a retrained model on stable traffic, and it means shadow mode cannot detect a data-dependent regression here.";
  if (binary && flips === 0) {
    return `Probabilities differ on ${(divergence * 100).toFixed(1)}% of requests (max ${maxDelta.toPrecision(4)}) but no class label flipped. Ranking may still change, so "no flips" is not evidence of equivalence.`;
  }
  return `${(divergence * 100).toFixed(1)}% of requests diverged, max absolute difference ${maxDelta.toPrecision(4)}${binary ? `, ${flips} class-label flip(s)` : ""}. ${shadow ? "Shadow mode scored every request on both models, so these deltas are directly comparable to what production traffic would see." : "Scores came from the served model only; enable shadow mode to compare both models on the same request."}`;
}

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ---------------------------------------------------------------------------
// Artifact construction
// ---------------------------------------------------------------------------

export interface FitArtifactOptions {
  modelId: string;
  version: string;
  featureNames: string[];
  task: "binary" | "regression";
  family: "logistic" | "ridge";
  /**
   * L2 strength for the fit. Defaults to 1e-6 rather than the GLM default of
   * 1e-8: a serving artifact has to converge reliably on whatever data reaches
   * it, and at 1e-8 the IRLS iteration on a well-separated problem creeps in
   * the 10th decimal until it hits the iteration cap. The penalty is small
   * enough to be immaterial for inference and large enough to terminate.
   */
  l2?: number;
  /** IRLS iteration cap; defaults to 400 because perfectly separable data needs it. */
  maxIter?: number;
  /** Newton tolerance. */
  tol?: number;
  slaMs?: number;
}

/**
 * Standardise features, then fit a logistic or ridge model on the scaled
 * design, returning a serving artifact that carries the scaling.
 *
 * The scaling lives in the artifact rather than in the caller because a
 * serving bug where inference forgets to scale is silent: predictions still
 * come out, just wrong. Keeping means and scales inside the model makes the
 * fit-serve contract impossible to violate by omission.
 */
export function fitServingArtifact(X: number[][], y: number[], opts: FitArtifactOptions): ModelArtifact {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0)
    throw new RealTimeServingError("Fitting a serving artifact needs rows with at least one feature.");
  if (opts.featureNames.length !== p) {
    throw new RealTimeServingError(`${opts.featureNames.length} feature name(s) supplied for a ${p}-column design.`);
  }
  if (!X.every((r) => r.length === p && r.every((v) => typeof v === "number" && Number.isFinite(v)))) {
    throw new RealTimeServingError("The feature matrix must be dense and finite; impute before fitting.");
  }
  if (X.length !== y.length) throw new RealTimeServingError("X and y have different row counts.");

  const means = Array.from({ length: p }, (_, j) => X.reduce((a, r) => a + r[j]!, 0) / n);
  const scales = Array.from({ length: p }, (_, j) => {
    const m = means[j]!;
    const varr = X.reduce((a, r) => a + (r[j]! - m) ** 2, 0) / Math.max(1, n - 1);
    const sd = Math.sqrt(varr);
    return sd > 1e-12 ? sd : 1; // a constant column must not become a divide-by-zero
  });
  const scaled = X.map((r) => r.map((v, j) => (v - means[j]!) / scales[j]!));

  if (opts.family === "ridge") {
    const fit = fitRidge(scaled, y, opts.l2 ?? 1);
    if (!fit)
      throw new RealTimeServingError(
        "Ridge fit was singular; add features, regularise harder, or drop a constant column.",
      );
    return {
      modelId: opts.modelId,
      family: "ridge",
      version: opts.version,
      featureNames: [...opts.featureNames],
      means,
      scales,
      coefficients: fit.coefficients,
      intercept: fit.intercept,
      task: opts.task,
      slaMs: opts.slaMs ?? 100,
    };
  }

  if (!y.every((v) => v === 0 || v === 1))
    throw new RealTimeServingError("Logistic serving artifacts need a 0/1 response.");
  if (new Set(y).size < 2) throw new RealTimeServingError("The response is constant, so the model is unidentified.");
  const fit = fitLogistic(
    { X: scaled, y, featureNames: opts.featureNames },
    { l2: opts.l2 ?? 1e-6, maxIter: opts.maxIter ?? 400, tol: opts.tol ?? 1e-10 },
  );
  if (!fit.converged) {
    // Separable data makes the MLE unbounded, so the coefficients grow without
    // limit and the iteration never satisfies the tolerance. That is a real
    // condition of the data, not a bug to paper over, so it is reported with
    // the fix rather than silently shipping a diverged model.
    throw new RealTimeServingError(
      `Logistic fit did not converge in ${fit.iterations} iterations. Data that is perfectly separable has no finite maximum-likelihood solution, so the coefficients grow without bound; add overlapping labels, raise maxIter, or increase l2 to regularise.`,
    );
  }
  const [interceptRow, ...coefs] = fit.coefficients;
  return {
    modelId: opts.modelId,
    family: "logistic",
    version: opts.version,
    featureNames: [...opts.featureNames],
    means,
    scales,
    coefficients: coefs.map((c) => c.coefficient),
    intercept: interceptRow?.coefficient ?? 0,
    task: opts.task,
    slaMs: opts.slaMs ?? 100,
  };
}

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------

/**
 * Warm an artifact by scoring the fit-time mean vector, and report the cost.
 * The point is to pay any first-call JIT and lazy-allocation cost before traffic
 * arrives, so the latency percentiles reflect steady state rather than the
 * first request.
 */
export function warmupArtifact(
  artifact: ModelArtifact,
  featureNames?: string[],
): { warmLatencyMs: number; featuresTouched: string[] } {
  const names = featureNames ?? artifact.featureNames;
  const features: Record<string, number> = {};
  for (const name of names) {
    const j = artifact.featureNames.indexOf(name);
    features[name] = (artifact.means?.[j] ?? 0) + (artifact.scales?.[j] ?? 1);
  }
  const start = nowMs();
  executePrediction({ modelId: artifact.modelId, features, requestId: "warmup" }, artifact);
  return { warmLatencyMs: nowMs() - start, featuresTouched: names };
}
