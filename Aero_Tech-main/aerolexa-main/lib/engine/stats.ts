/**
 * Pure statistics primitives. Every analysis kind composes these functions so
 * methodology text always matches the code that produced the numbers.
 *
 * Numerical policy: non-finite values (NaN, ±Infinity) are treated as missing
 * and ignored by location/dispersion/quantile measures unless otherwise noted —
 * the parse pipeline already normalizes dirty cells to `null`, this is a
 * defence-in-depth layer for hand-built rows. Mean/median/min/max/variance of
 * an *effectively empty* input return NaN (the historic contract), so callers
 * can detect "no usable data" rather than silently getting 0.
 */

/** True when `v` is a usable (finite) number. */
export function isFiniteNumber(v: number | undefined | null): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Drop NaN / ±Infinity from a sample, keeping order and count of survivors. */
export function cleanFinite(values: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const v of values) if (isFiniteNumber(v)) out.push(v);
  return out;
}

export function sum(values: number[]): number {
  let acc = 0;
  for (const v of cleanFinite(values)) acc += v;
  return acc;
}

export function mean(values: number[]): number {
  const clean = cleanFinite(values);
  if (clean.length === 0) return Number.NaN;
  let acc = 0;
  for (const v of clean) acc += v;
  // Divide last: keeps relative error small and overflow-free for big sums.
  return acc / clean.length;
}

/**
 * Variance (sample `n-1` by default, matching NumPy/SciPy ddof=1). Uses a
 * two-pass formula: the sum of squared deviations from the mean avoids the
 * catastrophic cancellation of `E[x²] - E[x]²` for large, near-constant values.
 */
export function variance(values: number[], sample = true): number {
  const clean = cleanFinite(values);
  const n = clean.length;
  if (n === 0) return Number.NaN;
  if (n < 2) return 0;
  const m = mean(clean);
  let acc = 0;
  for (const v of clean) {
    const d = v - m;
    acc += d * d;
  }
  return acc / (sample ? n - 1 : n);
}

export function stddev(values: number[], sample = true): number {
  return Math.sqrt(variance(values, sample));
}

export function min(values: number[]): number {
  const clean = cleanFinite(values);
  if (clean.length === 0) return Number.NaN;
  let m = clean[0] as number;
  for (const v of clean) if (v < m) m = v;
  return m;
}

export function max(values: number[]): number {
  const clean = cleanFinite(values);
  if (clean.length === 0) return Number.NaN;
  let m = clean[0] as number;
  for (const v of clean) if (v > m) m = v;
  return m;
}

export function median(values: number[]): number {
  return quantile(cleanFinite(values), 0.5);
}

/**
 * Linear-interpolation quantile (R type 7, the NumPy/SciPy default). Non-finite
 * values are ignored, so `q(NaN, 0.5)` matches `np.nanquantile`.
 */
export function quantile(values: number[], q: number): number {
  const clean = cleanFinite(values);
  const n = clean.length;
  if (n === 0) return Number.NaN;
  const sorted = [...clean].sort((a, b) => a - b);
  if (q <= 0) return sorted[0] as number;
  if (q >= 1) return sorted[n - 1] as number;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base] as number;
  const hi = (sorted[Math.min(n - 1, base + 1)] as number) ?? lo;
  return lo + rest * (hi - lo);
}

/** Five-number summary [min, q1, median, q3, max]. */
export function fiveNumberSummary(values: number[]): [number, number, number, number, number] {
  const clean = cleanFinite(values);
  if (clean.length === 0) return [0, 0, 0, 0, 0];
  const q = (p: number) => quantile(clean, p);
  return [min(clean), q(0.25), median(clean), q(0.75), max(clean)];
}

/** Outliers beyond the classic 1.5×IQR box-plot fences. */
export function outlierCount(values: number[]): number {
  const clean = cleanFinite(values);
  if (clean.length < 4) return 0;
  const q1 = quantile(clean, 0.25);
  const q3 = quantile(clean, 0.75);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr === 0) return 0;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  let count = 0;
  for (const v of clean) if (v < lo || v > hi) count++;
  return count;
}

/** Histogram with nice bin edges (Freedman–Diaconis-ish, clamped). */
export function histogram(values: number[], bins?: number): { edges: number[]; counts: number[]; binLabels: string[] } {
  const clean = cleanFinite(values);
  if (clean.length === 0) return { edges: [], counts: [], binLabels: [] };
  const lo = min(clean);
  const hi = max(clean);
  if (hi === lo) return { edges: [lo, hi + 1], counts: [clean.length], binLabels: [`${lo}`] };
  const iqr = quantile(clean, 0.75) - quantile(clean, 0.25);
  let n = bins;
  if (!n) {
    const fd = (2 * iqr) / Math.cbrt(clean.length);
    n = Math.max(5, Math.min(40, Math.ceil((hi - lo) / (fd > 0 ? fd : 1))));
  }
  n = Math.max(2, Math.min(60, Math.round(n)));
  const width = (hi - lo) / n;
  const counts = new Array<number>(n).fill(0);
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) edges.push(lo + i * width);
  for (const v of clean) {
    let idx = Math.floor((v - lo) / width);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const binLabels = edges.slice(0, n).map((e, i) => `${trimNum(e)}–${trimNum(edges[i + 1] as number)}`);
  return { edges, counts, binLabels };
}

function trimNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return (Math.round(v * 100) / 100).toString();
}

/**
 * Pearson correlation on pairwise-complete, finite samples + a two-sided
 * p-value from the exact Student-t distribution (n − 2 df) via the
 * regularized incomplete beta function — the same statistic SciPy's
 * `stats.pearsonr` reports (it uses the beta CDF too), NOT the normal
 * approximation older builds used.
 */
export function pearson(x: number[], y: number[]): { r: number; p: number; n: number } {
  const len = Math.min(x.length, y.length);
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < len; i++) {
    const xv = x[i];
    const yv = y[i];
    if (isFiniteNumber(xv) && isFiniteNumber(yv)) {
      px.push(xv);
      py.push(yv);
    }
  }
  const n = px.length;
  if (n < 3) return { r: Number.NaN, p: 1, n };
  const mx = mean(px);
  const my = mean(py);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const xd = (px[i] as number) - mx;
    const yd = (py[i] as number) - my;
    num += xd * yd;
    dx += xd * xd;
    dy += yd * yd;
  }
  const denom = Math.sqrt(dx * dy);
  const r = denom === 0 ? Number.NaN : num / denom;
  let p = 1;
  if (Number.isFinite(r) && Math.abs(r) === 1) {
    p = 0; // degenerate stack of points — scipy returns 0 too
  } else if (Number.isFinite(r) && n > 3) {
    // t = r·√((n−2)/(1−r²)) under the null ρ=0; two-sided p via the beta CDF.
    const df = n - 2;
    const t = r * Math.sqrt(df / (1 - r * r));
    p = studentTPValue(t, df);
  }
  return { r, p, n };
}

/**
 * Two-sided critical t value for significance level `alpha` with `df`
 * degrees of freedom — the exact inverse of the Student-t survival via
 * bisection on regularizedIncompleteBeta (|t| boundary of the 1−alpha
 * central interval). Deterministic to ~1e-12, monotone in df.
 */
export function studentTCriticalTwoSided(alpha: number, df: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1 || !Number.isFinite(df) || df <= 0) return Number.NaN;
  // p(|T| > t) = I_{df/(df+t²)}(df/2, 1/2) — bisect t for target alpha.
  let lo = 0;
  let hi = 1;
  const twoSided = (t: number) => regularizedIncompleteBeta(df / 2, 0.5, df / (df + t * t));
  while (twoSided(hi) > alpha) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (twoSided(mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Two-sided p-value for a t-statistic with `df` degrees of freedom.
 * Uses the identity 2·P(T ≥ |t|) = I_{df/(df+t²)}(df/2, 1/2) where I is the
 * regularized incomplete beta — the exact Student-t survival (Numerical
 * Recipes betai). 0 < p ≤ 1.
 */
export function studentTPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return Number.NaN;
  const x = df / (df + t * t);
  const p = regularizedIncompleteBeta(df / 2, 0.5, x);
  if (!Number.isFinite(p)) return Number.NaN;
  return Math.min(1, Math.max(0, p));
}

/** Regularized incomplete beta I_x(a, b) — continuous fraction + Lanczos Γ. */
function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  // Symmetry keeps the continued fraction convergent for x near 1.
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Lentz continued fraction for the incomplete beta (Numerical Recipes). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Log-gamma via the Lanczos approximation (accurate to ~1e-15, x > 0). */
function logGamma(x: number): number {
  const cof = [
    76.18009172947146,
    // Documented Lanczos coefficients quoted to their published precision — the
    // nearest double is intended, so the lint rule's "precision loss" is a no-op.
    // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
    -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  const g = 5;
  let y = x;
  let tmp = x + g + 0.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < cof.length; j++) ser += (cof[j] as number) / (y = y + 1);
  // eslint-disable-next-line @typescript-eslint/no-loss-of-precision -- sqrt(2π) at published precision
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/**
 * Multiple ordinary least squares via QR decomposition (Householder
 * reflections) of the centered design matrix — numerically stable where the
 * normal equations (XᵀX)⁻¹Xᵀy square the condition number. The intercept is
 * recovered from the column means, so coefficient j is the partial effect of
 * regressor j holding the others fixed (the basis of controlling for
 * confounders in the what-if engine).
 *
 * Standard errors come from σ̂²(XᵀX)⁻¹ on the centered design; p-values are
 * the exact two-sided Student-t (n−rank−1 df) via regularizedIncompleteBeta —
 * the same numbers statsmodels/sklearn summary reports, not an asymptotic
 * approximation. HC1 heteroskedasticity-robust standard errors (the statsmodels
 * `cov_type='HC1'` default) are returned alongside for inference that stays
 * valid under non-constant error variance. Returns null when the system is
 * rank-deficient.
 */
export function ols(
  X: number[][],
  y: number[],
): {
  coefficients: number[];
  intercept: number;
  /** Classical (homoskedastic) standard errors — σ̂²(XᵀX)⁻¹ diagonal. */
  standardErrors: number[];
  pValues: number[];
  /** HC1 heteroskedasticity-robust standard errors (MacKinnon–White 1985). */
  hc1StandardErrors: number[];
  /** Two-sided Student-t p-values from the HC1 standard errors. */
  hc1PValues: number[];
  rSquared: number;
  n: number;
} | null {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || n <= p) return null;
  if (!X.every((row) => row.length === p)) return null;
  // Center X and y — removes the intercept from the linear algebra and makes
  // coefficients invariant to the location of each regressor.
  const means = Array.from({ length: p }, (_, j) => X.reduce((acc, row) => acc + (row[j] as number), 0) / n);
  const yMean = y.reduce((acc, v) => acc + v, 0) / n;
  const Xc = X.map((row) => row.map((v, j) => v - (means[j] as number)));
  const yc = y.map((v) => v - yMean);

  // Householder QR in-place: R accumulates in the upper triangle of A.
  const A: number[][] = Xc.map((row, i) => [...row, yc[i] as number]);
  for (let k = 0; k < p; k++) {
    let norm = 0;
    for (let i = k; i < n; i++) norm += (A[i]?.[k] as number) ** 2;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return null; // rank-deficient (duplicate / constant column)
    const a00 = A[k]?.[k] as number;
    const alpha = a00 >= 0 ? -norm : norm;
    const v: number[] = new Array(n - k).fill(0);
    v[0] = a00 - alpha;
    let vNormSq = v[0]! * v[0]!;
    for (let i = k + 1; i < n; i++) {
      v[i - k] = A[i]?.[k] as number;
      vNormSq += (v[i - k] as number) * (v[i - k] as number);
    }
    if (vNormSq < 1e-300) continue;
    // Apply H = I − 2vvᵀ/(vᵀv) to the trailing submatrix (all p+1 columns).
    for (let j = k; j <= p; j++) {
      let dot = 0;
      for (let i = k; i < n; i++) dot += (v[i - k] as number) * (A[i]?.[j] as number);
      const factor = (2 * dot) / vNormSq;
      for (let i = k; i < n; i++) (A[i] as number[])[j] = (A[i]?.[j] as number) - factor * (v[i - k] as number);
    }
  }
  // Back-substitution on R y' = Qᵀy (last column of A holds Qᵀy).
  const betaC: number[] = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let acc = A[i]?.[p] as number;
    for (let j = i + 1; j < p; j++) acc -= (A[i]?.[j] as number) * (betaC[j] as number);
    const diag = A[i]?.[i] as number;
    if (Math.abs(diag) < 1e-12) return null;
    betaC[i] = acc / diag;
  }
  const coefficients = betaC.map((b) => b);
  const intercept = yMean - coefficients.reduce((acc, b, j) => acc + b * (means[j] as number), 0);

  // σ̂² from centered residuals; df = n − p − 1 (intercept counts as a param).
  const df = n - p - 1;
  if (df <= 0) return null;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fitted = coefficients.reduce((acc, b, j) => acc + b * (Xc[i]?.[j] as number), 0);
    ssRes += ((yc[i] as number) - fitted) ** 2;
  }
  const sigma2 = ssRes / df;
  // Var(β̂) = σ̂² (XᵀX)⁻¹ diagonal — recovered by back-substituting unit
  // vectors against Rᵀ (rows of Rᵀ solve R w = e_j only when RᵀR = XᵀX; here
  // we invert R in place: (RᵀR)⁻¹ = R⁻¹R⁻ᵀ, diagonal = Σ R⁻¹[i,j]²).
  const Rinv: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let j = 0; j < p; j++) {
    // Solve R w = e_j by back-substitution (R upper-triangular).
    for (let i = p - 1; i >= 0; i--) {
      let acc = i === j ? 1 : 0;
      for (let k2 = i + 1; k2 < p; k2++) acc -= (A[i]?.[k2] as number) * (Rinv[k2]![j] as number);
      Rinv[i]![j] = acc / (A[i]?.[i] as number);
    }
  }
  const standardErrors = Array.from({ length: p }, (_, j) =>
    // (RᵀR)⁻¹ = R⁻¹R⁻ᵀ → diagonal entry j is the sum of squares of ROW j of
    // R⁻¹ (not column j — that product runs along the row of the first factor).
    Math.sqrt(sigma2 * Rinv[j]!.reduce((acc, v) => acc + v * v, 0)),
  );
  const pValues = standardErrors.map((se, j) => {
    const b = coefficients[j] as number;
    if (!Number.isFinite(se)) return 1;
    // Perfect fit (SSE = 0 ⇒ σ̂ = 0): |t| = ∞, matching the p = 0 that
    // statsmodels and scipy.linregress report for noise-free data. A nonzero
    // coefficient with zero standard error is infinitely significant, not
    // insignificant; b = 0 with se = 0 is 0/0-degenerate → 1.
    if (se === 0) return b === 0 ? 1 : 0;
    const t = Math.abs(b) / se;
    return Math.min(1, Math.max(0, studentTPValue(t, df)));
  });
  const ssTot = yc.reduce((acc, v) => acc + v * v, 0);
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  // HC1 heteroskedasticity-robust standard errors (MacKinnon–White 1985) —
  // valid inference when the error variance is NOT constant across rows, the
  // case for most real business data. Sandwich form on the centered design
  // (slope covariances identical to the full [1 X] form):
  //   cov = (n/(n−p−1)) · B M B,  B = (XcᵀXc)⁻¹ = R⁻¹R⁻ᵀ,
  //   M = Σ eᵢ² xcᵢ xcᵢᵀ (the meat). Classical SEs stay untouched above.
  const bread = Rinv.map((row) => row.map((v, j) => row.reduce((acc, _, k) => acc + v * (Rinv[k] as number[])[j]!, 0)));
  const meat: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < n; i++) {
    const fitted = coefficients.reduce((acc, b, j) => acc + b * (Xc[i]?.[j] as number), 0);
    const e = (yc[i] as number) - fitted;
    const e2 = e * e;
    for (let a = 0; a < p; a++) {
      for (let b2 = a; b2 < p; b2++) {
        meat[a]![b2] = (meat[a]![b2] ?? 0) + e2 * (Xc[i]?.[a] as number) * (Xc[i]?.[b2] as number);
      }
    }
  }
  for (let a = 0; a < p; a++) for (let b2 = 0; b2 < a; b2++) meat[a]![b2] = meat[b2]![a]!;
  // cov = (n/df) · bread · meat · bread (p³, p is small).
  const bm = Array.from({ length: p }, (_, a) =>
    Array.from({ length: p }, (_, b2) => bread[a]!.reduce((acc, v, k) => acc + v * meat[k]![b2]!, 0)),
  );
  const hc1Var = Array.from({ length: p }, (_, a) => {
    const row = bm[a]!;
    return ((n / df) * bread[a]!.reduce((acc, v, k) => acc + v * row[k]!, 0)) as number;
  });
  const hc1StandardErrors = hc1Var.map((v) => (v > 0 ? Math.sqrt(v) : 0));
  const hc1PValues = coefficients.map((b, j) => {
    const se = hc1StandardErrors[j] as number;
    if (!Number.isFinite(se)) return 1;
    if (se === 0) return b === 0 ? 1 : 0;
    const t = Math.abs(b / se);
    return Math.min(1, Math.max(0, studentTPValue(t, df)));
  });

  return { coefficients, intercept, standardErrors, pValues, hc1StandardErrors, hc1PValues, rSquared, n };
}

/** Ordinary least squares linear fit y = a + b·x on index values. */
export function linearRegression(y: number[]): {
  slope: number;
  intercept: number;
  r2: number;
  stderr: number;
  n: number;
} {
  const clean = cleanFinite(y);
  const n = clean.length;
  if (n < 2) return { slope: 0, intercept: clean[0] ?? 0, r2: 0, stderr: 0, n };
  const x = clean.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = mean(clean);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((x[i] as number) - mx) * ((clean[i] as number) - my);
    sxx += ((x[i] as number) - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = intercept + slope * (x[i] as number);
    ssRes += ((clean[i] as number) - fitted) ** 2;
    ssTot += ((clean[i] as number) - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const stderr = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
  return { slope, intercept, r2, stderr, n };
}

/** Deterministic seeded k-means (maxmin seeding). Returns cluster index per row. */
export function kmeans(data: number[][], k: number, maxIter = 60): number[] {
  // Drop rows containing non-finite values; they cannot be meaningfully placed.
  const usable = data.filter((row) => row.every(isFiniteNumber));
  const n = usable.length;
  if (n === 0 || k <= 1) return new Array<number>(data.length).fill(-1);
  const kk = Math.min(k, n);
  const dim = usable[0]?.length ?? 0;

  // Maxmin seeding — deterministic, no random module.
  const centers: number[][] = [];
  const first = usable[0];
  if (!first) return new Array<number>(data.length).fill(-1);
  centers.push([...first]);
  const nearest = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  for (let c = 1; c < kk; c++) {
    let bestDist = -1;
    let bestIdx = 0;
    for (let i = 0; i < n; i++) {
      const d = distSq(usable[i] as number[], centers[c - 1] as number[]);
      if (d < (nearest[i] as number)) nearest[i] = d;
      if ((nearest[i] as number) > bestDist) {
        bestDist = nearest[i] as number;
        bestIdx = i;
      }
    }
    centers.push([...(usable[bestIdx] as number[])]);
  }

  const assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < kk; c++) {
        const d = distSq(usable[i] as number[], centers[c] as number[]);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assign[i] !== bestC) {
        assign[i] = bestC;
        changed = true;
      }
    }
    const sums: number[][] = Array.from({ length: kk }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i] as number;
      counts[c] = (counts[c] ?? 0) + 1;
      const row = usable[i] as number[];
      for (let d = 0; d < dim; d++)
        (sums[c] as number[])[d] = ((sums[c] as number[])[d] as number) + (row[d] as number);
    }
    for (let c = 0; c < kk; c++) {
      const count = counts[c] ?? 0;
      const sum = sums[c] as number[];
      for (let d = 0; d < dim; d++) {
        centers[c]![d] = count > 0 ? (sum[d] as number) / count : (centers[c]![d] as number);
      }
    }
    if (!changed && iter > 2) break;
  }

  // Map usable-row assignments back to the caller's row indexes (-1 = dropped).
  const out = new Array<number>(data.length).fill(-1);
  let idx = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i]?.every(isFiniteNumber)) out[i] = assign[idx++] as number;
  }
  return out;
}

function distSq(a: number[], b: number[]): number {
  let acc = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (b[i] as number);
    acc += d * d;
  }
  return acc;
}

/** Standardize columns to z-scores (for clustering without scale bias). */
export function standardize(matrix: number[][]): number[][] {
  const dims = matrix[0]?.length ?? 0;
  const means: number[] = [];
  const sds: number[] = [];
  for (let d = 0; d < dims; d++) {
    const col = cleanFinite(matrix.map((r) => r[d]));
    means.push(mean(col));
    sds.push(stddev(col) || 1);
  }
  return matrix.map((row) => {
    const out: number[] = [];
    for (let d = 0; d < row.length; d++) {
      const v = row[d];
      out.push(isFiniteNumber(v) ? (v - (means[d] as number)) / ((sds[d] as number) || 1) || 0 : Number.NaN);
    }
    return out;
  });
}

/** Round a change into an "up/down/flat" trend for UI affordances. */
export function trendDirection(pctChange: number | null | undefined): "up" | "down" | "flat" {
  if (pctChange === null || pctChange === undefined || !Number.isFinite(pctChange)) return "flat";
  if (pctChange > 0.5) return "up";
  if (pctChange < -0.5) return "down";
  return "flat";
}

// ---------------------------------------------------------------------------
// Forecasting & distribution primitives (upgraded engine)
// ---------------------------------------------------------------------------

/**
 * Standard normal CDF Φ(x) — Abramowitz & Stegun 7.1.26 erf approximation
 * (|ε| ≤ 1.5e-7), used by normality and forecast diagnostics.
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** Φ⁻¹ via the Acklam inverse-normal approximation (|ε| ≤ 1.15e-9 relative). */
export function normalInv(p: number): number {
  if (!(p > 0) || !(p < 1)) return Number.NaN;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * Two-sided p-value for a t-statistic, exact via the incomplete beta —
 * re-exported internally as `studentTPValue` (see above). Nothing new here;
 * declared for discoverability by the forecast/whatif engines.
 */

/**
 * Spearman rank correlation on pairwise-complete samples with an exact-ish
 * t-distribution p-value (the standard rank-transformed Pearson). Non-finite
 * pairs are dropped; ties get average ranks (the scipy.stats.spearmanr
 * convention), so the statistic matches SciPy on tied data too.
 */
export function spearman(x: number[], y: number[]): { rho: number; p: number; n: number } {
  const len = Math.min(x.length, y.length);
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < len; i++) {
    if (isFiniteNumber(x[i]) && isFiniteNumber(y[i])) {
      px.push(x[i] as number);
      py.push(y[i] as number);
    }
  }
  const n = px.length;
  if (n < 3) return { rho: Number.NaN, p: 1, n };
  const rx = averageRanks(px);
  const ry = averageRanks(py);
  const res = pearson(rx, ry);
  return { rho: res.r, p: res.p, n };
}

/** Average ranks for tied values (1-based), in the order given. */
function averageRanks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] as { v: number }).v === (idx[i] as { v: number }).v) j++;
    const avg = (i + j + 2) / 2; // ranks are 1-based: positions i..j → (i+1)..(j+1)
    for (let k = i; k <= j; k++) ranks[(idx[k] as { i: number }).i] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Mann–Kendall trend test on a time series (two-sided, tie-corrected
 * variance, normal approximation with continuity correction — the standard
 * MK test used in hydrology/climatology for monotonic trend detection).
 * Returns the S statistic, z score, two-sided p-value and τ (Kendall's tau-b
 * style normalized measure of monotonic association with time).
 */
export function mannKendall(values: number[]): {
  s: number;
  z: number;
  p: number;
  tau: number;
  n: number;
  direction: "increasing" | "decreasing" | "no trend";
} {
  const clean = cleanFinite(values);
  const n = clean.length;
  if (n < 4) return { s: 0, z: 0, p: 1, tau: 0, n, direction: "no trend" };
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (clean[j] as number) - (clean[i] as number);
      if (d > 0) s++;
      else if (d < 0) s--;
    }
  }
  // Tie-corrected variance (Freedman / Sen):
  const counts = new Map<number, number>();
  for (const v of clean) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of counts.values()) if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (varS <= 0) return { s: 0, z: 0, p: 1, tau: 0, n, direction: "no trend" };
  const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
  const totalPairs = (n * (n - 1)) / 2;
  const tau = totalPairs > 0 ? s / totalPairs : 0;
  const direction = p < 0.05 ? (z > 0 ? "increasing" : "decreasing") : "no trend";
  return { s, z, p, tau, n, direction };
}

/**
 * Multiplicative seasonal indices per period-of-year from a bucketed series.
 * Uses the ratio-to-moving-average convention: each observation is divided by
 * the centered 2-period-of-year moving average, then ratios are averaged per
 * season. Falls back to a simple mean-ratio when the series is too short.
 */
export function seasonalIndices(values: number[], period: number): number[] {
  const n = values.length;
  if (period < 2 || n < 2 * period) return new Array(period).fill(1);
  const ratios: number[][] = Array.from({ length: period }, () => []);
  const h = Math.floor(period / 2);
  for (let i = 0; i < n; i++) {
    const season = i % period;
    // Centered moving average over CONSECUTIVE positions (all seasons mixed):
    // this is the classic ratio-to-moving-average level estimate. For even
    // periods the window has period+1 points (standard 2×m convention).
    const window: number[] = [];
    for (let k = -h; k <= h; k++) {
      const j = i + k;
      if (j >= 0 && j < n && j !== i) window.push(values[j] as number);
    }
    const base = mean(window);
    const v = values[i] as number;
    if (Number.isFinite(base) && base !== 0 && Number.isFinite(v)) ratios[season]?.push(v / base);
  }
  const raw = ratios.map((r) => (r.length ? mean(r) : 1));
  // Normalize so mean index = 1 (pure seasonal effect, no level shift).
  const m = mean(raw);
  if (!Number.isFinite(m) || m === 0) return new Array(period).fill(1);
  return raw.map((v) => v / m);
}

/**
 * Shapiro–Wilk-style normality screening (Anderson–Darling statistic with
 * a calibrated p-value approximation — robust to n ≥ 8 and much more stable
 * than a naive skew/kurtosis read). Reports A², the rejection verdict at the
 * 5% level and a plain-language interpretation. This is a real goodness-of-fit
 * statistic computed from the sample, not a heuristic flag.
 */
export function normalityCheck(values: number[]): {
  statistic: number;
  pValue: number;
  passed: boolean;
  interpretation: string;
  n: number;
} {
  const clean = cleanFinite(values);
  const n = clean.length;
  if (n < 8) {
    return {
      statistic: Number.NaN,
      pValue: Number.NaN,
      passed: true,
      interpretation: "Too few values (n < 8) for a normality test — no assumption made either way.",
      n,
    };
  }
  const mu = mean(clean);
  const sd = stddev(clean, false);
  if (!Number.isFinite(sd) || sd === 0) {
    return { statistic: 0, pValue: 1, passed: true, interpretation: "Zero variance — constant data.", n };
  }
  // Anderson–Darling A² on standardized values. The correct pairing weights
  // the i-th smallest with the i-th LARGEST order statistic:
  //   A² = −n − (1/n)·Σ (2i−1)·[ln F(x_(i)) + ln(1 − F(x_(n+1−i)))]
  const sorted = [...clean].sort((a, b) => a - b);
  const zOf = (v: number) => (v - mu) / sd;
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const fi = Math.min(1 - 1e-12, Math.max(1e-12, normalCdf(zOf(sorted[i] as number))));
    const fMirror = Math.min(1 - 1e-12, Math.max(1e-12, normalCdf(zOf(sorted[n - 1 - i] as number))));
    a2 += (2 * i + 1) * (Math.log(fi) + Math.log(1 - fMirror));
  }
  a2 = -n - a2 / n;
  // D'Agostino–Stephens small-sample adjustment for normality (modified A*).
  const a2Star = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  // p-value approximation for the normal case (D'Agostino & Stephens table fit).
  const pValue =
    a2Star >= 0.6
      ? Math.exp(1.321 + 5.306 * Math.log(a2Star) - 6.222 * a2Star)
      : Math.exp(0.917 - 4.279 * a2Star - 1.38 * a2Star * a2Star);
  // 5% critical value for the adjusted A²* statistic, normal case
  // (Stephens 1974 / D'Agostino & Stephens 1986): 0.787.
  const passed = a2Star < 0.787;
  return {
    statistic: Math.round(a2 * 1e6) / 1e6,
    pValue: Math.min(1, Math.max(0, Math.round(pValue * 1e4) / 1e4)),
    passed,
    interpretation: passed
      ? "Data are consistent with a normal distribution at the 5% level — mean/±1.96σ bands and OLS inference are appropriate."
      : "Data deviate from normality at the 5% level — prefer medians/IQR for central-tendency reads and treat linear-model intervals with care.",
    n,
  };
}

/**
 * Rolling-origin backtest of a one-step-ahead forecaster over a series.
 * Returns MAE, RMSE and MAPE over every forecast origin — the honest way to
 * compare candidate forecast methods on the user's own data before projecting.
 */
export function backtestSeries(
  values: number[],
  forecast: (history: number[]) => number,
  minTrain = 4,
): { mae: number; rmse: number; mape: number; folds: number } {
  const clean = cleanFinite(values);
  const errors: number[] = [];
  const pcts: number[] = [];
  for (let i = minTrain; i < clean.length; i++) {
    const history = clean.slice(0, i);
    const actual = clean[i] as number;
    const pred = forecast(history);
    if (!Number.isFinite(pred)) continue;
    errors.push(actual - pred);
    if (actual !== 0) pcts.push(Math.abs((actual - pred) / actual));
  }
  const mae = errors.length ? mean(errors.map(Math.abs)) : Number.NaN;
  const rmse = errors.length ? Math.sqrt(mean(errors.map((e) => e * e))) : Number.NaN;
  const mape = pcts.length ? mean(pcts) * 100 : Number.NaN;
  return { mae, rmse, mape, folds: errors.length };
}
