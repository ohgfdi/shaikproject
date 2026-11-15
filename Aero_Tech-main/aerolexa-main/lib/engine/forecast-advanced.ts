/**
 * Advanced forecasting — exogenous regressors + hierarchical reconciliation.
 *
 * Extends the repo's ETS/Theta/ARIMA engine (`lib/engine/forecast.ts`) with
 * the two capabilities its header explicitly lists as out of scope:
 *
 *  1. ARIMAX-style regression with AR(1) errors (Hyndman & Athanasopoulos,
 *     ch. 9 "dynamic regression"):
 *
 *        y_t = β·x_t + η_t,    η_t = φ·η_{t−1} + ε_t
 *
 *     β is estimated by Cochrane–Orcutt iteration: OLS → estimate φ from the
 *     residual autocorrelation (Yule–Walker) → quasi-difference y and X →
 *     refit → repeat to convergence. Point forecasts need FUTURE values of x
 *     (scenarios: "if price stays at 99, demand is…"), and prediction
 *     intervals come from the residual σ with the AR(1) variance accumulation
 *     Var(η_{T+h}) = σ²·(1 − φ^{2h}) / (1 − φ²), plus the conditional
 *     propagation of the last residual, η_{T+h} = φ^h·η_T.
 *
 *  2. Top-down hierarchical reconciliation (Hyndman et al. 2011, the
 *     "forecast proportions" TDFP variant): base forecasts exist at every
 *     level of a hierarchy (company → region → store), but naively summed
 *     they do not add up. Reconciliation re-distributes the ROOT's forecast
 *     down the tree using each child's share of the aggregated base forecast,
 *     so every level sums exactly. Coherence is a property of the procedure,
 *     not a hope.
 *
 * DETERMINISM: closed-form recursions and fixed iteration caps. Same input ⇒
 * byte-identical output. No RNG anywhere.
 *
 * HONESTY: every result carries its assumptions — AR(1) error structure,
 * known future x (the caller supplies the scenario), and the known trade-off
 * that top-down reconciliation imposes the root's error structure on the
 * children (bottom-up and middle-out are the standard alternatives, printed
 * in the methodology).
 */

import { mean, normalInv, ols } from "@/lib/engine/stats";

export class ForecastAdvancedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastAdvancedError";
  }
}

// ---------------------------------------------------------------------------
// 1. Regression with AR(1) errors (ARIMAX-style)
// ---------------------------------------------------------------------------

export interface ArimaxPoint {
  h: number;
  point: number;
  low: number;
  high: number;
}

export interface ArimaxResult {
  /** Regression coefficients in ORIGINAL units (aligned with `regressorNames`). */
  coefficients: number[];
  intercept: number;
  regressorNames: string[];
  /** AR(1) coefficient of the error process (0 ⇒ white-noise errors). */
  phi: number;
  /** Residual σ of the final quasi-differenced fit. */
  sigma: number;
  /** In-sample fitted values on the ORIGINAL scale (β·x + φ-propagated residual). */
  fitted: number[];
  /** y − fitted on the original scale. */
  residuals: number[];
  /** R² on the original scale. */
  rSquared: number;
  /** Cochrane–Orcutt iterations actually used. */
  iterations: number;
  /** Did the φ iteration converge to the tolerance? */
  converged: boolean;
  points: ArimaxPoint[];
  methodology: string[];
  warnings: string[];
  interpretation: string;
}

export interface ArimaxOptions {
  /** Forecast horizon (1–52). */
  horizon: number;
  /** Future regressor paths, horizon × p, aligned with the columns of `X`. REQUIRED. */
  futureX: number[][];
  /** 80% or 95% intervals (default 0.95). */
  level?: number;
}

const MAX_CO_ITERATIONS = 30;
const PHI_TOL = 1e-6;

/** Quasi-difference a series: z_t = v_t − φ·v_{t−1} (drops the first element). */
function quasiDiff(v: number[], phi: number): number[] {
  const out: number[] = [];
  for (let t = 1; t < v.length; t++) out.push((v[t] as number) - phi * (v[t - 1] as number));
  return out;
}

/** Yule–Walker AR(1) estimate: φ = γ₁/γ₀ of the series. Deterministic, clamped to (−1, 1). */
export function estimateAr1(v: number[]): number {
  const n = v.length;
  if (n < 3) return 0;
  const m = mean(v);
  let c0 = 0;
  let c1 = 0;
  for (let t = 0; t < n; t++) c0 += ((v[t] as number) - m) ** 2;
  for (let t = 1; t < n; t++) c1 += ((v[t] as number) - m) * ((v[t - 1] as number) - m);
  if (c0 < 1e-30) return 0;
  return Math.max(-0.999, Math.min(0.999, c1 / c0));
}

/**
 * Dynamic regression: y = Xβ + η, η ~ AR(1), by Cochrane–Orcutt iteration.
 * X must NOT include an intercept (added internally); all values finite.
 */
export function arimaxForecast(
  y: number[],
  X: number[][],
  opts: ArimaxOptions,
  regressorNames?: string[],
): ArimaxResult {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n < 10) throw new ForecastAdvancedError("Need at least 10 observations for dynamic regression.");
  if (p === 0) {
    throw new ForecastAdvancedError(
      "ARIMAX needs at least one exogenous regressor — use lib/engine/forecast.ts otherwise.",
    );
  }
  if (X.length !== n) throw new ForecastAdvancedError("y and X must have the same number of rows.");
  if (!X.every((row) => row.length === p)) throw new ForecastAdvancedError("X must be rectangular (n × p).");
  for (let t = 0; t < n; t++) {
    if (!Number.isFinite(y[t] as number)) throw new ForecastAdvancedError(`y[${t}] is not finite.`);
    for (let j = 0; j < p; j++) {
      if (!Number.isFinite(X[t]![j] as number)) throw new ForecastAdvancedError(`X[${t}][${j}] is not finite.`);
    }
  }
  const H = Math.max(1, Math.min(52, Math.floor(opts.horizon)));
  if (opts.futureX.length < H) {
    throw new ForecastAdvancedError(
      `futureX must contain ${H} rows (the full horizon) — scenarios need known future x.`,
    );
  }
  for (let h = 0; h < H; h++) {
    if ((opts.futureX[h] as number[]).length !== p) {
      throw new ForecastAdvancedError(
        `futureX[${h}] has ${(opts.futureX[h] as number[]).length} columns; expected ${p}.`,
      );
    }
    for (let j = 0; j < p; j++) {
      if (!Number.isFinite(opts.futureX[h]?.[j] as number)) {
        throw new ForecastAdvancedError(
          `futureX[${h}][${j}] is not finite — forecast scenarios require known future regressors.`,
        );
      }
    }
  }

  // ----- Cochrane–Orcutt iteration -------------------------------------------
  let phi = 0;
  let beta: number[] = new Array(p).fill(0);
  let intercept = 0;
  let iterations = 0;
  let converged = false;

  for (let it = 1; it <= MAX_CO_ITERATIONS; it++) {
    iterations = it;
    const yUse = phi === 0 ? y : quasiDiff(y, phi);
    const XUse = phi === 0 ? X : X.slice(1).map((row, t) => row.map((v, j) => v - phi * (X[t]![j] as number)));
    const fit = ols(XUse, yUse);
    if (!fit) throw new ForecastAdvancedError("Regression is rank-deficient — drop duplicate/collinear regressors.");
    beta = fit.coefficients;
    intercept = fit.intercept;
    const phiNext = estimateAr1(residualOf(y, X, intercept, beta));
    const delta = Math.abs(phiNext - phi);
    phi = phiNext;
    if (delta < PHI_TOL) {
      converged = true;
      break;
    }
  }

  // ----- Final fit at the converged φ (refit once more for clean outputs) -----
  const yF = phi === 0 ? y : quasiDiff(y, phi);
  const XF = phi === 0 ? X : X.slice(1).map((row, t) => row.map((v, j) => v - phi * (X[t]![j] as number)));
  const fitF = ols(XF, yF);
  if (!fitF) throw new ForecastAdvancedError("Final GLS refit is rank-deficient — drop collinear regressors.");
  beta = fitF.coefficients;
  intercept = fitF.intercept;

  // In-sample fitted values on the ORIGINAL scale: β·x_t plus the AR(1)
  // one-step error correction η_t = φ·η_{t−1} propagated from the residuals.
  const xPart = y.map((_, t) => intercept + (X[t] as number[]).reduce((a, v, j) => a + v * (beta[j] as number), 0));
  const eta: number[] = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const raw = (y[t] as number) - (xPart[t] as number);
    eta[t] = t === 0 ? raw : phi * (eta[t - 1] as number) + raw;
  }
  // One-step-ahead fitted: β·x_t + φ·η_{t−1} (η_{t−1} is the updated state).
  const state: number[] = new Array(n).fill(0);
  for (let t = 1; t < n; t++)
    state[t] = (y[t - 1] as number) - (xPart[t - 1] as number) - (eta[t - 1] as number) + (eta[t - 1] as number);
  const fitted = y.map((_, t) =>
    t === 0 ? (xPart[t] as number) : (xPart[t] as number) + phi * ((y[t - 1] as number) - (xPart[t - 1] as number)),
  );
  const residuals = y.map((v, t) => v - (fitted[t] as number));

  const yMean = mean(y);
  const sst = y.reduce((a, v) => a + (v - yMean) ** 2, 0);
  const sse = residuals.reduce((a, r) => a + r * r, 0);
  const rSquared = sst > 1e-12 ? 1 - sse / sst : Number.NaN;
  const sigma = Math.sqrt(sse / Math.max(1, n - p - 1));

  // ----- Forecast path ---------------------------------------------------------
  const level = opts.level ?? 0.95;
  const z = normalInv(1 - (1 - level) / 2);
  const lastEta = residuals[residuals.length - 1] ?? 0;
  const points: ArimaxPoint[] = [];
  for (let h = 1; h <= H; h++) {
    const xRow = opts.futureX[h - 1] as number[];
    const point = intercept + xRow.reduce((a, v, j) => a + v * (beta[j] as number), 0);
    // Conditional mean of the error state: η_{T+h} = φ^h · η_T.
    const etaH = Math.pow(phi, h) * lastEta;
    // Unconditional AR(1) forecast variance around the conditional path.
    const varH = Math.abs(phi) < 1e-12 ? sigma * sigma : (sigma * sigma * (1 - Math.pow(phi, 2 * h))) / (1 - phi * phi);
    const half = z * Math.sqrt(Math.max(0, varH));
    points.push({ h, point: point + etaH, low: point + etaH - half, high: point + etaH + half });
  }

  const names = regressorNames ?? Array.from({ length: p }, (_, j) => `x${j + 1}`);
  const methodology = [
    "Dynamic regression y = Xβ + η with AR(1) errors, estimated by Cochrane–Orcutt iteration (OLS → Yule–Walker φ → quasi-differencing → refit).",
    `φ = ${phi.toFixed(4)} (0 = white-noise errors), σ = ${sigma.toFixed(4)}, R² = ${Number.isFinite(rSquared) ? rSquared.toFixed(3) : "n/a"}, ${iterations} iteration(s), ${converged ? "converged" : "NOT converged"}.`,
    `Prediction intervals use the AR(1) accumulation Var(h) = σ²(1 − φ^{2h})/(1 − φ²) at the ${(level * 100).toFixed(0)}% level.`,
    "Point forecasts CONDITION on the supplied future regressor paths — different scenarios = different forecasts.",
  ];
  const warnings: string[] = [];
  if (!converged) {
    warnings.push(
      `Cochrane–Orcutt did not converge in ${MAX_CO_ITERATIONS} iterations — the AR(1) estimate is unstable; inspect the residuals or restrict to white-noise errors.`,
    );
  }
  if (Math.abs(phi) > 0.95) {
    warnings.push(
      `φ = ${phi.toFixed(3)} is near the non-stationary boundary — intervals will be very wide and the trend assumption dominates.`,
    );
  }
  if (n < 3 * p + 10) {
    warnings.push(
      `Only ${n} rows for ${p} regressors — the β estimates will be noisy; prefer fewer, stronger regressors.`,
    );
  }

  const b0 = beta[0] as number;
  const last = points[points.length - 1] as ArimaxPoint;
  const interpretation = [
    `Each extra unit of ${names[0]} moves the outcome by ${b0 >= 0 ? "+" : ""}${b0.toFixed(4)} holding the AR structure fixed.`,
    `Horizon ${H}: ${last.point.toFixed(2)} (interval ${last.low.toFixed(2)} to ${last.high.toFixed(2)}).`,
    `Scenario-driven: change futureX and the forecast changes — this is the exogenous-regressor engine the plain ETS/ARIMA selector explicitly does not do.`,
  ].join(" ");

  return {
    coefficients: beta,
    intercept,
    regressorNames: names,
    phi,
    sigma,
    fitted,
    residuals,
    rSquared,
    iterations,
    converged,
    points,
    methodology,
    warnings,
    interpretation,
  };
}

function residualOf(y: number[], X: number[][], intercept: number, beta: number[]): number[] {
  return y.map((v, t) => v - intercept - (X[t] as number[]).reduce((a, w, j) => a + w * (beta[j] as number), 0));
}

// ---------------------------------------------------------------------------
// 2. Hierarchical reconciliation (top-down forecast proportions)
// ---------------------------------------------------------------------------

export interface HierarchyNode {
  name: string;
  /** Base (unreconciled) forecast for THIS node over the horizon (length H). */
  baseForecast: number[];
  children: HierarchyNode[];
}

export interface ReconciledNode {
  name: string;
  /** Coherent forecast — children sum EXACTLY to the parent at every h. */
  forecast: number[];
  children: ReconciledNode[];
}

export interface ReconciliationResult {
  root: ReconciledNode;
  /** Base vs reconciled divergence per level-1 child (largest = most revised). */
  revisions: { name: string; beforeMean: number; afterMean: number; revisionPct: number }[];
  methodology: string[];
  warnings: string[];
}

/**
 * Top-down reconciliation with forecast proportions (TDFP). The ROOT's
 * forecast is authoritative; each child receives share =
 *   baseChild_h / Σ_siblings baseSibling_h
 * of its parent's reconciled value at every horizon h. Children whose base
 * forecasts sum to zero at some h split the parent EQUALLY (documented,
 * deterministic). Recursion makes the WHOLE tree coherent.
 */
export function reconcileHierarchy(root: HierarchyNode, horizon: number): ReconciliationResult {
  const H = Math.floor(horizon);
  if (!Number.isInteger(H) || H < 1) throw new ForecastAdvancedError("horizon must be a positive integer.");
  if (!root.children.length) {
    throw new ForecastAdvancedError(
      "Hierarchy root must have at least one child (a single series needs no reconciliation).",
    );
  }

  const validate = (node: HierarchyNode, path: string): void => {
    if (node.baseForecast.length !== H) {
      throw new ForecastAdvancedError(`${path}: baseForecast length ${node.baseForecast.length} ≠ horizon ${H}.`);
    }
    for (let h = 0; h < H; h++) {
      if (!Number.isFinite(node.baseForecast[h] as number)) {
        throw new ForecastAdvancedError(`${path}: baseForecast[${h}] is not finite.`);
      }
    }
    for (const c of node.children) validate(c, `${path}/${c.name}`);
  };
  validate(root, root.name);

  const beforeMeans = new Map<string, number>();
  const collect = (node: HierarchyNode): void => {
    beforeMeans.set(node.name, mean(node.baseForecast));
    for (const c of node.children) collect(c);
  };
  collect(root);

  const reconcile = (node: HierarchyNode, target: number[]): ReconciledNode => {
    if (node.children.length === 0) {
      return { name: node.name, forecast: [...target], children: [] };
    }
    // Shares from the child base forecasts at each h (equal split on all-zero).
    const childForecasts: number[][] = node.children.map(() => new Array(H).fill(0));
    for (let h = 0; h < H; h++) {
      const bases = node.children.map((c) => c.baseForecast[h] as number);
      const sum = bases.reduce((a, b) => a + b, 0);
      const shares = Math.abs(sum) < 1e-12 ? bases.map(() => 1 / node.children.length) : bases.map((b) => b / sum);
      for (let j = 0; j < node.children.length; j++) {
        (childForecasts[j] as number[])[h] = (node.children[j] as HierarchyNode).name
          ? shares[j]! * (target[h] as number)
          : 0;
      }
    }
    const children = node.children.map((c, j) => reconcile(c, childForecasts[j] as number[]));
    return { name: node.name, forecast: [...target], children };
  };

  const reconciledRoot = reconcile(root, [...root.baseForecast]);

  const revisions = root.children.map((c) => {
    const before = beforeMeans.get(c.name) ?? Number.NaN;
    const after = mean((reconciledRoot.children.find((r) => r.name === c.name) as ReconciledNode).forecast);
    return {
      name: c.name,
      beforeMean: before,
      afterMean: after,
      revisionPct: before !== 0 ? ((after - before) / Math.abs(before)) * 100 : Number.NaN,
    };
  });

  // Coherence check (proof by construction, verified anyway): each level-1
  // child sum must equal the root exactly at every h.
  for (let h = 0; h < H; h++) {
    const s = reconciledRoot.children.reduce((a, c) => a + (c.forecast[h] as number), 0);
    if (
      Math.abs(s - (reconciledRoot.forecast[h] as number)) >
      1e-6 * (1 + Math.abs(reconciledRoot.forecast[h] as number))
    ) {
      throw new ForecastAdvancedError(
        `Reconciliation failed the coherence check at h=${h} (${s} ≠ ${reconciledRoot.forecast[h]}).`,
      );
    }
  }

  const maxRevision = revisions.reduce((a, r) => Math.max(a, Math.abs(r.revisionPct || 0)), 0);
  const warnings: string[] = [];
  if (maxRevision > 25) {
    warnings.push(
      `Largest level-1 revision is ${maxRevision.toFixed(1)}% — the base forecasts disagreed strongly with the root total; investigate the least-coherent series before trusting child-level numbers.`,
    );
  }

  const methodology = [
    "Top-down reconciliation with forecast proportions (TDFP, Hyndman et al. 2011): the root's forecast is authoritative; each child inherits share = baseChild / Σ baseSiblings of its parent at every horizon.",
    "Children with an all-zero base split the parent equally (documented fallback).",
    "Coherence is exact by construction and verified post-hoc (children sum to the parent at every h).",
    "Trade-off: top-down imposes the root's error structure on children — bottom-up (sums leaf forecasts) or middle-out are the standard alternatives when leaf accuracy matters more than stability.",
  ];

  return { root: reconciledRoot, revisions, methodology, warnings };
}
