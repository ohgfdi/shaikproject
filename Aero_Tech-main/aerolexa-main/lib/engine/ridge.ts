/**
 * Ridge (L2-regularized) linear regression — dependency-free, deterministic.
 *
 * Closes the what-if engine's biggest honest gap: when the plain-OLS signal is
 * weak (r² < 0.12) or the design is collinear, the projection used to drop
 * straight to a hypothetical 1:1 pass-through. Ridge keeps a REAL fitted
 * model alive in exactly those regimes — L2 shrinkage stabilizes slopes under
 * collinearity and small samples, and k-fold cross-validation decides
 * out-of-fold whether the regularized model actually beats the mean baseline
 * before it is allowed to speak.
 *
 * Math (standardized formulation):
 *  - Features are centered and scaled (z = (x − μ)/σ, σ > 0); degenerate
 *    (zero-variance) columns are pinned to coefficient 0 rather than blowing
 *    up the penalty. The intercept lives outside the penalty via centering.
 *  - Closed form: β = (ZᵀZ + αI)⁻¹ Zᵀy_c solved by Gaussian elimination with
 *    partial pivoting — no iteration, no RNG, bit-identical runs.
 *  - Coefficients are mapped back to ORIGINAL units: b_j = β_j/σ_j,
 *    intercept = ȳ − Σ b_j μ_j.
 *
 * Cross-validation contract (deterministic, matching every engine here):
 *  - Folds are assigned row → fold (i mod k) — a fixed, documented convention;
 *    no shuffling, so the same rows always produce the same folds.
 *  - cvR² = 1 − SSE_oof / SST where SST is the full-sample variance around ȳ
 *    (the mean predictor is the baseline being beaten). cvR² ≤ 0 means the
 *    ridge model does NOT generalize better than "predict the mean" and the
 *    caller must refuse to promote it.
 *  - Alpha ties break toward the LARGER alpha — the simpler (more-shrunk)
 *    model — consistent with the repo's "ties break toward simpler models".
 *
 * Unit-tested (__tests__/unit/ridge.test.ts) against hand-solved normal
 * equations and fold arithmetic; consumed by lib/engine/whatif.ts.
 */

/** Solve the (p × p) system A x = b by Gaussian elimination with partial pivoting. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0 || A.length !== n || A.some((row) => row.length !== n)) return null;
  // Augmented copy — inputs stay untouched (callers reuse A across folds).
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: largest |value| in the column wins (deterministic tie → lowest row).
    let pivot = col;
    let best = Math.abs(M[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row]![col]!);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (best < 1e-12) return null; // singular even after regularization (α too small + collinear)
    if (pivot !== col) {
      const tmp = M[col]!;
      M[col] = M[pivot]!;
      M[pivot] = tmp;
    }
    const diag = M[col]![col]!;
    for (let row = col + 1; row < n; row++) {
      const factor = M[row]![col]! / diag;
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[row]![k]! -= factor * M[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = M[row]![n]!;
    for (let k = row + 1; k < n; k++) s -= M[row]![k]! * x[k]!;
    x[row] = s / M[row]![row]!;
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

export interface RidgeFit {
  /** Coefficients in ORIGINAL feature units (zero for dropped columns). */
  coefficients: number[];
  intercept: number;
}

/**
 * Fit ridge on centered+scaled features and map back to original units.
 * Returns null when the design is empty or α makes the system unsolvable.
 */
export function fitRidge(X: number[][], y: number[], alpha: number): RidgeFit | null {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || X.length !== n || !X.every((row) => row.length === p)) return null;
  if (!Number.isFinite(alpha) || alpha < 0) return null;

  const means = Array.from({ length: p }, (_, j) => X.reduce((acc, r) => acc + (r[j] as number), 0) / n);
  const yMean = y.reduce((acc, v) => acc + v, 0) / n;
  const sds = Array.from({ length: p }, (_, j) => {
    const varj = X.reduce((acc, r) => acc + ((r[j] as number) - means[j]!) ** 2, 0) / (n - 1 || 1);
    return Math.sqrt(varj);
  });

  // Z: standardized design; zero-variance columns collapse to 0 (dropped).
  const Z = X.map((r) => r.map((v, j) => (sds[j]! > 1e-12 ? (v - means[j]!) / sds[j]! : 0)));
  const yc = y.map((v) => v - yMean);

  const G: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const rhs = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const zi = Z[i]!;
    for (let j = 0; j < p; j++) {
      if (zi[j] === 0) continue;
      rhs[j]! += zi[j]! * yc[i]!;
      for (let k = j; k < p; k++) {
        if (zi[k] === 0) continue;
        G[j]![k]! += zi[j]! * zi[k]!;
      }
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) G[j]![k] = G[k]![j]!;
    G[j]![j]! += alpha; // penalty on slopes only; intercept handled by centering
  }

  const beta = solveLinearSystem(G, rhs);
  if (!beta) return null;

  const coefficients = beta.map((b, j) => (sds[j]! > 1e-12 ? b / sds[j]! : 0));
  const intercept = yMean - coefficients.reduce((acc, b, j) => acc + b * means[j]!, 0);
  if (!coefficients.every(Number.isFinite) || !Number.isFinite(intercept)) return null;
  return { coefficients, intercept };
}

export interface CrossValidatedRidgeOptions {
  /** Alpha grid — deterministic, ascending (default tuned for standardized features). */
  alphas?: number[];
  /** Fold count (default 5, capped at ⌊n/4⌋ so every fold has ≥ 4 rows). */
  folds?: number;
}

export interface CrossValidatedRidge {
  /** Winning alpha (largest on ties — the more-shrunk, simpler model). */
  alpha: number;
  /** Out-of-fold R² of the winner vs the mean baseline. ≤ 0 ⇒ not promotable. */
  cvR2: number;
  /** Number of CV folds actually used. */
  folds: number;
  /** Winning model in original units. */
  coefficients: number[];
  intercept: number;
  /** Out-of-fold MAE of the winner (descriptive only). */
  cvMae: number;
}

const DEFAULT_ALPHAS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];

/**
 * K-fold cross-validated ridge with deterministic folds (row i → fold i mod k)
 * and a deterministic alpha grid. Returns the alpha with the best out-of-fold
 * R² against the mean baseline, its model, and the diagnostics the caller
 * needs to REFUSE promotion when nothing beats the baseline.
 */
export function crossValidatedRidge(
  X: number[][],
  y: number[],
  opts: CrossValidatedRidgeOptions = {},
): CrossValidatedRidge | null {
  const n = y.length;
  const alphas = (opts.alphas ?? DEFAULT_ALPHAS).slice().sort((a, b) => a - b);
  if (alphas.length === 0 || alphas.some((a) => !Number.isFinite(a) || a < 0)) return null;
  const requestedFolds = opts.folds ?? 5;
  const folds = Math.max(2, Math.min(requestedFolds, Math.floor(n / 4)));
  if (!Number.isFinite(folds) || folds < 2 || n < 8) return null;

  const yMean = y.reduce((acc, v) => acc + v, 0) / n;
  const sst = y.reduce((acc, v) => acc + (v - yMean) ** 2, 0);
  if (sst <= 1e-12) return null; // constant outcome — nothing to explain

  // Standardize ONCE on the full sample (folds evaluate prediction, not the
  // scaler; the what-if caller only ever projects near the observed means).
  const p = X[0]?.length ?? 0;
  if (p === 0) return null;
  const means = Array.from({ length: p }, (_, j) => X.reduce((acc, r) => acc + (r[j] as number), 0) / n);
  const sds = Array.from({ length: p }, (_, j) => {
    const varj = X.reduce((acc, r) => acc + ((r[j] as number) - means[j]!) ** 2, 0) / (n - 1 || 1);
    return Math.sqrt(varj);
  });
  const Z = X.map((r) => r.map((v, j) => (sds[j]! > 1e-12 ? (v - means[j]!) / sds[j]! : 0)));
  const yc = y.map((v) => v - yMean);

  let best: { alpha: number; cvR2: number; cvMae: number; beta: number[] } | null = null;
  for (const alpha of alphas) {
    const oof = new Array<number>(n).fill(0); // out-of-fold predictions (centered scale)
    const covered = new Array<boolean>(n).fill(false);
    let solvable = true;
    for (let f = 0; f < folds && solvable; f++) {
      const trainIdx: number[] = [];
      const testIdx: number[] = [];
      for (let i = 0; i < n; i++) (i % folds === f ? testIdx : trainIdx).push(i);
      if (trainIdx.length < 2 || testIdx.length === 0) {
        solvable = false;
        break;
      }
      // Fold-local normal equations over the standardized TRAIN rows.
      const G: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
      const rhs = new Array<number>(p).fill(0);
      for (const i of trainIdx) {
        const zi = Z[i]!;
        for (let j = 0; j < p; j++) {
          if (zi[j] === 0) continue;
          rhs[j]! += zi[j]! * yc[i]!;
          for (let k = j; k < p; k++) {
            if (zi[k] === 0) continue;
            G[j]![k]! += zi[j]! * zi[k]!;
          }
        }
      }
      for (let j = 0; j < p; j++) {
        for (let k = 0; k < j; k++) G[j]![k] = G[k]![j]!;
        G[j]![j]! += alpha;
      }
      const beta = solveLinearSystem(G, rhs);
      if (!beta) {
        solvable = false;
        break;
      }
      for (const i of testIdx) {
        const zi = Z[i]!;
        let pred = 0;
        for (let j = 0; j < p; j++) pred += zi[j]! * beta[j]!;
        oof[i] = pred; // centered scale — mean baseline is 0 here
        covered[i] = true;
      }
    }
    if (!solvable || !covered.every(Boolean)) continue; // this alpha cannot be scored everywhere — skip it

    let sse = 0;
    let mae = 0;
    for (let i = 0; i < n; i++) {
      const err = yc[i]! - oof[i]!;
      sse += err * err;
      mae += Math.abs(err);
    }
    const cvR2 = 1 - sse / sst;
    const cvMae = mae / n;
    // Ties (within 1e-12) break toward the LARGER alpha — the more-shrunk,
    // simpler model (the grid iterates ascending, so equal scores overwrite).
    if (!best || cvR2 > best.cvR2 + 1e-12 || (Math.abs(cvR2 - best.cvR2) <= 1e-12 && alpha > best.alpha)) {
      best = { alpha, cvR2, cvMae, beta: [] };
    }
    // The final model is refit on ALL rows at the winning alpha — the standard
    // CV-then-refit protocol — so no per-fold betas need storing here.
  }

  if (!best) return null;
  const finalFit = fitRidge(X, y, best.alpha);
  if (!finalFit) return null;
  return {
    alpha: best.alpha,
    cvR2: best.cvR2,
    folds,
    coefficients: finalFit.coefficients,
    intercept: finalFit.intercept,
    cvMae: best.cvMae,
  };
}
