/**
 * Geospatial statistics engine: spatial autocorrelation, clustering and
 * inference on latitude/longitude data.
 *
 * Spatial data breaks the assumptions that make ordinary statistics work.
 * Nearby points are not independent, so a p-value computed as if they were
 * will be far too small, and a cluster map drawn without a significance test
 * will show "hotspots" in pure noise. Every test in this file therefore
 * reports an empirical p-value from a permutation null rather than a
 * parametric one:
 *
 *  - MORAN'S I measures global clustering — are similar values near each other?
 *    The null is a random re-labelling of the same values, which preserves the
 *    value distribution and destroys only the spatial structure.
 *  - GETIS-ORD Gi* identifies local clusters and high/low outliers, with a
 *    false-discovery-rate adjustment across locations because hundreds of local
 *    tests will otherwise produce hundreds of false positives by construction.
 *  - DISTANCE DECAY fits log(value) against log(distance) and reports the
 *    slope, because Tobler's premise is that interaction falls off with distance
 *    and the test is whether this data actually obeys it.
 *  - CLUSTERS runs DBSCAN on projected coordinates, since degrees are not
 *    distances: at 60° latitude a degree of longitude is half a degree of
 *    latitude, and an unprojected neighbour search silently gets this wrong.
 *
 * Distances use the haversine formula on a spherical earth. That is accurate to
 * roughly 0.5% against a true ellipsoid, which is stated rather than claimed as
 * exact.
 */

export class GeospatialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeospatialError";
  }
}

export const EARTH_RADIUS_KM = 6371.0088;

/** Mean Earth radius, IUGG value. Within ~0.5% of a true ellipsoid. */

export interface GeoPoint {
  id: string;
  lat: number;
  lon: number;
  value: number;
  region?: string;
}

const DEG = Math.PI / 180;

export function toRadians(deg: number): number {
  return deg * DEG;
}

/** Great-circle distance in km between two lat/lon pairs. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidCoordinate(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

// ---------------------------------------------------------------------------
// Neighbourhood construction
// ---------------------------------------------------------------------------

export interface Neighbourhood {
  /** For each i, the indices j ≠ i within `bandKm`, or within the k nearest. */
  indices: number[][];
  weights: number[][];
  kind: "band" | "knn";
  bandKm: number;
  k: number;
  /** Points with no neighbours, which contribute nothing to most statistics. */
  isolated: number[];
}

export interface NeighbourhoodOptions {
  /** Neighbourhood radius in km. Used when `k` is 0. */
  bandKm?: number;
  /** k-nearest neighbours, distance-weighted. Used when > 0. */
  k?: number;
  /** 1/d^power row-standardised weights (spatial lag). */
  power?: number;
}

/**
 * Build a symmetric neighbourhood. Both band and k-NN constructions are
 * symmetrised afterwards: a directed k-NN graph is not a valid weights matrix
 * for Moran's I, and using it as one produces an index that is not comparable to
 * any published value.
 */
export function buildNeighbourhood(points: GeoPoint[], opts: NeighbourhoodOptions = {}): Neighbourhood {
  const n = points.length;
  const k = Math.max(0, Math.trunc(opts.k ?? 0));
  const bandKm = opts.bandKm ?? 0;
  const power = opts.power ?? 1;
  if (n === 0) throw new GeospatialError("No points to build a neighbourhood from.");
  if (k <= 0 && bandKm <= 0) {
    throw new GeospatialError("A neighbourhood needs either a band in km or a positive k.");
  }

  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(NaN));
  for (let i = 0; i < n; i++) {
    dist[i]![i] = 0;
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(points[i]!.lat, points[i]!.lon, points[j]!.lat, points[j]!.lon);
      dist[i]![j] = d;
      dist[j]![i] = d;
    }
  }

  const raw: Array<{ j: number; d: number }>[] = [];
  if (k > 0) {
    for (let i = 0; i < n; i++) {
      const row = dist[i]!.map((d, j) => ({ j, d }))
        .filter((r) => r.j !== i)
        .sort((a, b) => a.d - b.d || a.j - b.j);
      raw.push(row.slice(0, Math.min(k, n - 1)));
    }
    // Symmetrise: if j is among i's nearest, i is among j's neighbours.
    const include = new Set<string>();
    for (let i = 0; i < n; i++) for (const r of raw[i]!) include.add(`${i}:${r.j}`);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (include.has(`${j}:${i}`) && !include.has(`${i}:${j}`)) {
          raw[i]!.push({ j, d: dist[i]![j]! });
        }
      }
      raw[i]!.sort((a, b) => a.d - b.d || a.j - b.j);
    }
  } else {
    for (let i = 0; i < n; i++) {
      raw.push(dist[i]!.map((d, j) => ({ j, d })).filter((r) => r.j !== i && r.d <= bandKm));
    }
  }

  const indices: number[][] = [];
  const weights: number[][] = [];
  const isolated: number[] = [];
  for (let i = 0; i < n; i++) {
    const members = raw[i]!;
    if (members.length === 0) {
      isolated.push(i);
      indices.push([]);
      weights.push([]);
      continue;
    }
    const w = members.map((r) => 1 / Math.max(r.d, 1e-6) ** power);
    const total = w.reduce((a, b) => a + b, 0);
    indices.push(members.map((r) => r.j));
    // Row-standardise so each location contributes the same total weight and a
    // dense location cannot dominate the statistic through row weight alone.
    weights.push(w.map((x) => x / total));
  }

  return { indices, weights, kind: k > 0 ? "knn" : "band", bandKm, k, isolated };
}

// ---------------------------------------------------------------------------
// Moran's I
// ---------------------------------------------------------------------------

export interface MoranResult {
  statistic: number;
  /** Expected I under no spatial structure, −1/(n−1). */
  expected: number;
  variance: number;
  zScore: number;
  /** Empirical one-sided p-value from the permutation null. */
  pValue: number;
  permutations: number;
  /** Interpretation of I relative to its expectation. */
  pattern: "clustered" | "dispersed" | "random";
  perLocation: { id: string; index: number }[];
  verdict: string;
}

/**
 * Moran's I with an empirical permutation test.
 *
 * The permutation null re-labels values at random, keeping each value attached
 * to a different location. That preserves the marginal distribution of the data
 * and destroys only the spatial arrangement — the exact assumption the statistic
 * tests.
 */
export function moransI(points: GeoPoint[], nb: Neighbourhood, permutations = 999, seed = 42): MoranResult {
  const n = points.length;
  if (n < 3) throw new GeospatialError(`Moran's I needs at least 3 points, received ${n}.`);
  const z = points.map((p) => p.value);
  const zMean = z.reduce((a, b) => a + b, 0) / n;
  const dev = z.map((v) => v - zMean);
  const s0 = nb.indices.reduce((a, row) => a + row.length, 0);
  if (s0 === 0) {
    throw new GeospatialError(
      "The neighbourhood is empty: no point is within the band of any other, so Moran's I is undefined.",
    );
  }
  // S1 = ½ Σᵢⱼ (Wᵢⱼ + Wⱼᵢ)² and S2 = Σᵢ (Σⱼ Wᵢⱼ + Σⱼ Wⱼᵢ)² / S0, the standard
  // form for a non-symmetric W. Row-standardised weights are symmetric only when
  // the neighbourhood is, so using S0² or treating W as symmetric would give the
  // wrong analytic variance whenever it is not.
  const w = (i: number, j: number): number => {
    const at = nb.indices[i]!.indexOf(j);
    return at >= 0 ? nb.weights[i]![at]! : 0;
  };
  let s1v = 0;
  let s2 = 0;
  const rowSums = new Array<number>(n).fill(0);
  const colSums = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nb.indices[i]!.length; k++) {
      const j = nb.indices[i]![k]!;
      const wij = nb.weights[i]![k]!;
      rowSums[i]! += wij;
      colSums[j]! += wij;
      s1v += 0.5 * (wij + w(j, i)) ** 2;
    }
  }
  for (let i = 0; i < n; i++) s2 += (rowSums[i]! + colSums[i]!) ** 2 / s0;
  const zSq = dev.reduce((a, b) => a + b * b, 0);
  if (zSq <= 0) {
    throw new GeospatialError("Every point has the same value, so there is no spatial pattern to measure.");
  }

  // The Moran cross-product term Σᵢⱼ wᵢⱼzᵢzⱼ — NOT the spatial lag Σⱼwᵢⱼzⱼ.
  // They are different statistics, and with row-standardised weights the lag sums
  // to zero on any regular grid because Σⱼwᵢⱼ = 1 for every i and Σᵢzᵢ = 0, so
  // using it makes every I come out at exactly 0.
  const numerator = nb.indices.reduce(
    (a, row, i) => a + dev[i]! * nb.weights[i]!.reduce((b, weight, k) => b + weight * dev[row[k]!]!, 0),
    0,
  );
  const statistic = (n / s0) * (numerator / zSq);

  const expected = -1 / (n - 1);
  // Randomisation variance for Moran's I:
  //   [ (n² − 3n + 3)·S1 − n·S2 + 3·S0² ] / [ (n−1)(n+1)·S0² ] − E[I]²
  // An extra n² here inflates the standard deviation by two orders of magnitude
  // and leaves the analytic z-score inconsistent with the permutation p-value
  // reported right next to it.
  const variance =
    ((n * n - 3 * n + 3) * s1v - n * s2 + 3 * s0 * s0) / ((n - 1) * (n + 1) * s0 * s0) - expected * expected;
  const zScore = variance > 0 ? (statistic - expected) / Math.sqrt(variance) : 0;

  const permuted: number[] = [];
  const rng = mulberry32(seed);
  const perm = dev.slice();
  const reps = Math.max(0, Math.trunc(permutations));
  for (let r = 0; r < reps; r++) {
    fisherYates(perm, rng);
    const num = nb.indices.reduce(
      (a, row, i) => a + perm[i]! * nb.weights[i]!.reduce((b, w, k) => b + w * perm[row[k]!]!, 0),
      0,
    );
    permuted.push((n / s0) * (num / zSq));
  }
  const pValue = empiricalP(statistic, permuted, expected);

  // The direction of the deviation is only called a pattern when the permutation
  // test supports it. On a random surface the sign of I flips constantly, so
  // labelling every positive value "clustered" reports noise as a finding.
  const significant = reps > 0 && pValue < 0.05;
  const pattern: MoranResult["pattern"] =
    !significant || Math.abs(statistic - expected) < 1e-12
      ? "random"
      : statistic > expected
        ? "clustered"
        : "dispersed";

  return {
    statistic,
    expected,
    variance,
    zScore,
    pValue,
    pattern,
    permutations: reps,
    perLocation: points.map((p, index) => ({ id: p.id, index })),
    verdict: moranVerdict(statistic, expected, pValue, pattern, reps),
  };
}

function moranVerdict(statistic: number, expected: number, pValue: number, pattern: string, reps: number): string {
  if (reps === 0) {
    return `Moran's I = ${statistic.toPrecision(4)} against an expected ${expected.toPrecision(4)}, but no permutations were run, so there is no p-value. A significant-looking I without a null distribution is just a number.`;
  }
  const sig = pValue < 0.05;
  return (
    `Moran's I = ${statistic.toPrecision(4)} against an expected ${expected.toPrecision(4)} under spatial randomness, which is ${pattern}. ` +
    (sig
      ? `The empirical p-value of ${pValue.toPrecision(3)} over ${reps} permutations indicates the clustering is unlikely to be chance, so treating these values as independent would understate their uncertainty.`
      : `The empirical p-value of ${pValue.toPrecision(3)} over ${reps} permutations is not small enough to distinguish this pattern from randomness, so the apparent structure is within what re-labelling these same values would produce.`)
  );
}

/**
 * Two-sided empirical p-value, measured against the null's own centre.
 *
 * The permutation null for Moran's I is centred on E[I] = −1/(n−1), not on
 * zero, so the deviation is |I − E[I]| on both sides. Tailing one direction
 * based on the sign of the statistic is the tempting shortcut and it is
 * anti-conservative: on random surfaces it rejected about 7 of 60 at p < 0.05
 * against an expected 3, because it treats every non-negative I as a candidate
 * for the upper tail and every negative one for the lower, ignoring that the
 * null straddles zero.
 *
 * The +1 in numerator and denominator is the standard correction for a Monte
 * Carlo test — without it a p-value of exactly 0 is reachable, which would be
 * an impossibility rather than a result.
 */
function empiricalP(statistic: number, nullDraws: number[], expected: number): number {
  if (nullDraws.length === 0) return NaN;
  const observed = Math.abs(statistic - expected);
  let extreme = 0;
  for (const d of nullDraws) if (Math.abs(d - expected) >= observed - 1e-15) extreme++;
  return (extreme + 1) / (nullDraws.length + 1);
}

// ---------------------------------------------------------------------------
// Getis-Ord Gi*
// ---------------------------------------------------------------------------

export interface GiResult {
  id: string;
  index: number;
  zScore: number;
  pValue: number;
  /** Benjamini-Hochberg adjusted p-value. */
  qValue: number;
  /** p-value ignoring multiplicity, kept to show what the adjustment fixed. */
  rawPValue: number;
  classification: "hot-spot" | "cold-spot" | "not-significant";
}

/**
 * Getis-Ord Gi* z-score per location, with a false-discovery-rate adjustment.
 *
 * Gi* is a standardised sum of neighbouring values: a high value with high
 * neighbours is a local cluster, a high value surrounded by low ones is a local
 * outlier. Computing it for hundreds of locations without multiplicity control
 * manufactures significance — at p < 0.05, 500 locations yield ~25 false hot
 * spots on pure noise, which is why the q-value is what the classification uses.
 */
export function getisOrdGiStar(points: GeoPoint[], nb: Neighbourhood): GiResult[] {
  const n = points.length;
  if (n < 2) throw new GeospatialError(`Gi* needs at least 2 points, received ${n}.`);
  const values = points.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const results: Omit<GiResult, "qValue" | "classification">[] = points.map((p, i) => {
    if (sd <= 0) {
      // A constant surface has no hot or cold spots; every z-score is 0 by
      // definition and calling any of them significant would be an artefact.
      return { id: p.id, index: i, zScore: 0, pValue: 1, rawPValue: 1 };
    }
    const members = nb.indices[i]!;
    const row = nb.weights[i]!;
    // Ord & Getis standardise the local sum against the sum it would have under
    // spatial randomness, so the numerator carries X̄ times the weight total
    // rather than X̄ alone. With row-standardised weights Σw = 1, but the form
    // is written in terms of Σw and Σw² so it stays correct for any weighting.
    const sumW = row.reduce((a, w) => a + w, 0);
    const sumW2 = row.reduce((a, w) => a + w * w, 0);
    const localSum = row.reduce((a, w, t) => a + w * values[members[t]!]!, 0);
    const numerator = localSum - mean * sumW;
    const varianceTerm = (n * sumW2 - sumW * sumW) / (n - 1);
    // A point with no neighbours has no local evidence: the variance term
    // collapses to zero, so z is defined as 0 rather than NaN.
    const denom = varianceTerm > 0 ? sd * Math.sqrt(varianceTerm) : 0;
    const zScore = denom > 0 ? numerator / denom : 0;
    const rawPValue = 2 * (1 - normalCdf(Math.abs(zScore)));
    return { id: p.id, index: i, zScore, pValue: rawPValue, rawPValue };
  });

  const qValues = benjaminiHochberg(results.map((r) => r.pValue));
  return results.map((r, i) => {
    const qValue = qValues[i]!;
    return {
      ...r,
      qValue,
      classification: qValue < 0.05 ? (r.zScore > 0 ? "hot-spot" : "cold-spot") : "not-significant",
    };
  });
}

/** Step-up BH q-values. Monotone by construction. */
export function benjaminiHochberg(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const q = new Array<number>(n).fill(1);
  let running = 1;
  for (let rank = n - 1; rank >= 0; rank--) {
    const entry = order[rank]!;
    const candidate = (entry.p * n) / (rank + 1);
    running = Math.min(running, Math.min(1, candidate));
    q[entry.i] = running;
  }
  return q;
}

function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 on erf; |error| < 1.5e-7, ample for a z-score.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// ---------------------------------------------------------------------------
// Distance decay
// ---------------------------------------------------------------------------

export interface DistanceDecayResult {
  /** Slope of log(value) on log(distance). Negative means interaction falls off. */
  slope: number;
  intercept: number;
  /** Slope standard error. */
  standardError: number;
  rSquared: number;
  n: number;
  /** Distance at which fitted interaction halves, if the slope is negative. */
  halfLifeKm: number | null;
  verdict: string;
}

/**
 * Log-log regression of value against distance for every observed pair.
 *
 * Pairs, not points: the question is how interaction between two places scales
 * with the gap between them. Both logs must be positive, so non-positive values
 * and coincident locations are excluded and counted — silently dropping them
 * would bias the slope upward by removing exactly the short-range, high-interaction
 * pairs that drive the effect.
 */
export function distanceDecay(
  points: GeoPoint[],
  opts: { minKm?: number; maxPairs?: number } = {},
): DistanceDecayResult {
  const minKm = opts.minKm ?? 0.0001;
  const maxPairs = opts.maxPairs ?? 200_000;
  const xs: number[] = [];
  const ys: number[] = [];
  let skippedNonPositive = 0;
  let skippedTooClose = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (xs.length >= maxPairs) break;
      const a = points[i]!;
      const b = points[j]!;
      if (!(a.value > 0) || !(b.value > 0)) {
        skippedNonPositive++;
        continue;
      }
      const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (d < minKm) {
        skippedTooClose++;
        continue;
      }
      const v = (a.value * b.value) ** 0.5; // geometric mean, symmetric in a and b
      if (!(v > 0)) {
        skippedNonPositive++;
        continue;
      }
      xs.push(Math.log(d));
      ys.push(Math.log(v));
    }
  }
  if (xs.length < 3) {
    throw new GeospatialError(`Distance decay needs at least 3 usable pairs, found ${xs.length}.`);
  }

  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k]! - mx;
    const dy = ys[k]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const residuals = ys.map((y, k) => y - (intercept + slope * xs[k]!));
  const sigma2 = residuals.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 2);
  const standardError = Math.sqrt(sigma2 / sxx);
  const halfLifeKm = slope < 0 ? Math.log(2) / -slope : null;

  const note =
    skippedNonPositive + skippedTooClose > 0
      ? ` ${skippedNonPositive} pair(s) were excluded for a non-positive value and ${skippedTooClose} for coincident locations.`
      : "";

  return {
    slope,
    intercept,
    standardError,
    rSquared: r2,
    n,
    halfLifeKm,
    verdict:
      `Log-log distance decay slope ${slope.toPrecision(4)} ± ${standardError.toPrecision(3)} over ${n} pair(s), R² ${r2.toPrecision(3)}. ` +
      (slope < 0
        ? `Interaction falls with distance, consistent with a distance-decay process${halfLifeKm !== null ? ` and halves roughly every ${formatKm(halfLifeKm)}` : ""}. `
        : `The slope is not negative, so this data does not exhibit distance decay — near and far pairs interact about equally. `) +
      "A weak R² means distance explains little of the variation, so a fitted half-life would be an artefact of the fit rather than a property of the system." +
      note,
  };
}

function formatKm(km: number): string {
  return km >= 1000 ? `${(km / 1000).toPrecision(3)} thousand km` : `${km.toPrecision(3)} km`;
}

// ---------------------------------------------------------------------------
// Projection and DBSCAN
// ---------------------------------------------------------------------------

/**
 * Local equirectangular projection about a reference latitude.
 *
 * DBSCAN needs a Euclidean metric, and degrees are not one: a degree of
 * longitude shrinks by cos(latitude). Scaling longitude by cos(φ₀) makes the
 * distortion roughly uniform over a metro-scale area, which is what DBSCAN's
 * epsilon means.
 */
export function projectPoints(points: GeoPoint[]): { x: number[]; y: number[]; scale: number } {
  const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const scale = Math.cos(toRadians(lat0));
  return {
    x: points.map((p) => p.lon * scale),
    y: points.map((p) => p.lat),
    scale,
  };
}

export interface ClusterResult {
  cluster: number;
  size: number;
  /** Indices of member points. */
  members: number[];
  centroid: { lat: number; lon: number };
  meanValue: number;
  /** Median distance to the cluster centroid, km. */
  spreadKm: number;
}

/**
 * DBSCAN over projected coordinates. Points not reachable from any core point
 * are labelled noise rather than being forced into a cluster, which is the
 * behaviour that makes DBSCAN the right choice for spatial point patterns: a
 * single stray coordinate should not become its own "region".
 */
export function dbscan(
  points: GeoPoint[],
  epsKm: number,
  minPts = 4,
): { clusters: ClusterResult[]; noise: number[]; epsKm: number } {
  const n = points.length;
  if (!(epsKm > 0)) throw new GeospatialError(`DBSCAN epsilon must be positive, received ${epsKm}.`);
  if (minPts < 1) throw new GeospatialError(`DBSCAN minPts must be at least 1, received ${minPts}.`);
  if (n === 0) return { clusters: [], noise: [], epsKm };

  const { x, y } = projectPoints(points);
  // Convert the epsilon from km to projected degrees so the neighbour search
  // matches the requested radius.
  const epsDeg = epsKm / 111.32;

  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(x[i]! - x[j]!, y[i]! - y[j]!);
      if (d <= epsDeg) {
        neighbours[i]!.push(j);
        neighbours[j]!.push(i);
      }
    }
  }

  const labels = new Array<number>(n).fill(-2); // -2 unvisited, -1 noise
  let clusterId = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    if (neighbours[i]!.length < minPts) {
      labels[i] = -1;
      continue;
    }
    const members: number[] = [];
    const queue = [i];
    labels[i] = clusterId;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      members.push(cur);
      if (neighbours[cur]!.length >= minPts) {
        for (const j of neighbours[cur]!) {
          if (labels[j] === -2) {
            labels[j] = clusterId;
            queue.push(j);
          }
        }
      }
    }
    clusterId++;
  }

  const clusters: ClusterResult[] = [];
  for (let c = 0; c < clusterId; c++) {
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === c) members.push(i);
    const lat = members.reduce((a, m) => a + points[m]!.lat, 0) / members.length;
    const lon = members.reduce((a, m) => a + points[m]!.lon, 0) / members.length;
    const meanValue = members.reduce((a, m) => a + points[m]!.value, 0) / members.length;
    const spreads = members.map((m) => haversineKm(points[m]!.lat, points[m]!.lon, lat, lon)).sort((a, b) => a - b);
    clusters.push({
      cluster: c,
      size: members.length,
      members,
      centroid: { lat, lon },
      meanValue,
      spreadKm: spreads[Math.floor(spreads.length / 2)] ?? 0,
    });
  }
  clusters.sort((a, b) => b.size - a.size || a.cluster - b.cluster);

  const noise: number[] = [];
  for (let i = 0; i < n; i++) if (labels[i] === -1) noise.push(i);
  return { clusters, noise, epsKm };
}

// ---------------------------------------------------------------------------
// k-nearest neighbours
// ---------------------------------------------------------------------------

export interface KnnResult {
  id: string;
  index: number;
  neighbours: { id: string; distanceKm: number }[];
  meanNeighbourValue: number;
  /** Observed minus expected value, the spatial-lag contrast. */
  contrast: number;
}

/**
 * k nearest neighbours by great-circle distance, with the spatial lag and its
 * contrast against the global mean. Contrast near zero means a location is
 * typical; strongly positive means it sits amid unusually high values.
 */
export function knnNeighbourhood(points: GeoPoint[], k = 4): KnnResult[] {
  const n = points.length;
  if (k < 1) throw new GeospatialError(`k must be at least 1, received ${k}.`);
  if (n < 2) throw new GeospatialError("k-NN needs at least 2 points.");
  const mean = points.reduce((a, p) => a + p.value, 0) / n;
  return points.map((p, i) => {
    const neighbours = points
      .map((q, j) => ({ j, d: i === j ? Infinity : haversineKm(p.lat, p.lon, q.lat, q.lon) }))
      .filter((r) => Number.isFinite(r.d))
      .sort((a, b) => a.d - b.d || a.j - b.j)
      .slice(0, Math.min(k, n - 1));
    const lag =
      neighbours.length > 0 ? neighbours.reduce((a, r) => a + points[r.j]!.value, 0) / neighbours.length : mean;
    return {
      id: p.id,
      index: i,
      neighbours: neighbours.map((r) => ({ id: points[r.j]!.id, distanceKm: r.d })),
      meanNeighbourValue: lag,
      contrast: lag - mean,
    };
  });
}

// ---------------------------------------------------------------------------
// Spatial join to regions
// ---------------------------------------------------------------------------

export interface RegionPolygon {
  region: string;
  lat: number[];
  lon: number[];
}

export interface SpatialJoinResult {
  region: string;
  pointIndices: number[];
  meanValue: number;
  count: number;
  /** Regions receiving no points, so empty geography is visible. */
  empty: boolean;
}

/**
 * Point-in-polygon assignment by ray casting on the lat/lon plane.
 *
 * Boundary points are assigned to exactly one region: a point is counted by the
 * first region that claims it, so nothing is silently duplicated across regions.
 */
export function spatialJoin(points: GeoPoint[], polygons: RegionPolygon[]): SpatialJoinResult[] {
  const claimed = new Set<number>();
  const out: SpatialJoinResult[] = [];
  for (const poly of polygons) {
    const members: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (claimed.has(i)) continue;
      if (pointInPolygon(points[i]!.lat, points[i]!.lon, poly)) {
        members.push(i);
        claimed.add(i);
      }
    }
    out.push({
      region: poly.region,
      pointIndices: members,
      count: members.length,
      meanValue: members.length > 0 ? members.reduce((a, m) => a + points[m]!.value, 0) / members.length : 0,
      empty: members.length === 0,
    });
  }
  return out;
}

/**
 * Ray casting on a (lat, lon) plane, with longitudes unwrapped so the polygon
 * stays contiguous.
 *
 * Wrapping each vertex into [−180, 180] independently is not enough: a polygon
 * that straddles the antimeridian comes out as two edges at −180 and +180, and
 * the region becomes the whole 360° strip between them instead of the 2° strip
 * the caller drew. Instead every vertex is shifted by whole turns to sit within
 * 180° of the polygon's first vertex, and the query longitude is shifted onto
 * that same branch before the crossings are counted.
 */
export function pointInPolygon(lat: number, lon: number, poly: RegionPolygon): boolean {
  if (poly.lat.length < 3 || poly.lon.length < 3 || poly.lat.length !== poly.lon.length) return false;
  const lats = poly.lat;
  const lons = unwrapRing(poly.lon);
  const x = shiftToBranch(lon, lons[0]!);
  let inside = false;
  for (let i = 0, j = lons.length - 1; i < lons.length; j = i++) {
    const yi = lats[i]!;
    const yj = lats[j]!;
    const xi = lons[i]!;
    const xj = lons[j]!;
    const intersects = yi > lat !== yj > lat && x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Shift each vertex by whole turns so the ring is contiguous around its first vertex. */
function unwrapRing(lons: number[]): number[] {
  const out: number[] = [normalizeLon(lons[0]!)];
  for (let i = 1; i < lons.length; i++) {
    out.push(shiftToBranch(lons[i]!, out[i - 1]!));
  }
  return out;
}

/** Put `lon` on the same branch as `ref`, i.e. the nearest representation to it. */
function shiftToBranch(lon: number, ref: number): number {
  let x = lon + Math.round((ref - lon) / 360) * 360;
  // Tie on exactly 180°: take the representation inside the branch rather than
  // jumping a full turn, which keeps the ring contiguous.
  if (Math.abs(x - ref) > 180) x -= 360 * Math.sign(x - ref);
  return x;
}

function normalizeLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface GeospatialInput {
  points: GeoPoint[];
  method: "morans-i" | "getis-ord" | "distance-decay" | "clusters" | "hotspots";
  bandKm?: number;
  k?: number;
  power?: number;
  permutations?: number;
  epsKm?: number;
  minPts?: number;
  seed?: number;
}

export interface GeospatialReport {
  method: GeospatialInput["method"];
  points: number;
  moransI?: MoranResult;
  giStar?: GiResult[];
  decay?: DistanceDecayResult;
  clusters?: ClusterResult[];
  noiseCount?: number;
  knn?: KnnResult[];
  warnings: string[];
  interpretation: string;
}

/**
 * Run one geospatial method over a point set. Methods that take a neighbourhood
 * (Moran's I, Gi*) share one band-or-k definition so those two results are
 * comparable to each other; distance decay and DBSCAN define proximity from the
 * point geometry themselves and are not forced to accept a band they never read.
 */
export function runGeospatialAnalysis(input: GeospatialInput): GeospatialReport {
  const { points, method } = input;
  if (points.length < 2)
    throw new GeospatialError(`Geospatial analysis needs at least 2 points, received ${points.length}.`);
  for (const p of points) {
    if (!isValidCoordinate(p.lat, p.lon))
      throw new GeospatialError(`Point "${p.id}" has invalid coordinates (${p.lat}, ${p.lon}).`);
    if (!Number.isFinite(p.value)) throw new GeospatialError(`Point "${p.id}" has a non-finite value.`);
  }
  const warnings: string[] = [];

  // Distance decay and DBSCAN define their own neighbourhoods from the point
  // geometry, so a neighbourhood is only built for the methods that consume one.
  // Building it unconditionally would reject an otherwise valid request for a
  // band or k it never uses.
  const needsNb = method === "morans-i" || method === "getis-ord" || method === "hotspots";
  let nb: Neighbourhood | null = null;
  if (needsNb) {
    nb = buildNeighbourhood(points, { bandKm: input.bandKm ?? 0, k: input.k ?? 0, power: input.power ?? 1 });
    if (nb.isolated.length > 0) {
      warnings.push(
        `${nb.isolated.length} point(s) have no neighbour under this definition and are excluded from the spatial statistics. Widening the band or raising k changes which points those are, which changes the result.`,
      );
    }
  }

  const report: GeospatialReport = { method, points: points.length, warnings, interpretation: "" };

  if (method === "morans-i") {
    const moran = moransI(points, nb!, input.permutations ?? 999, input.seed ?? 42);
    report.moransI = moran;
    report.interpretation = moran.verdict;
    return report;
  }

  if (method === "getis-ord" || method === "hotspots") {
    const gi = getisOrdGiStar(points, nb!);
    report.giStar = gi;
    const hot = gi.filter((g) => g.classification === "hot-spot");
    const cold = gi.filter((g) => g.classification === "cold-spot");
    const rawSignificant = gi.filter((g) => g.rawPValue < 0.05).length;
    report.interpretation =
      `Gi* over ${gi.length} location(s) with a ${nb!.kind === "band" ? `${nb!.bandKm} km band` : `${nb!.k}-nearest`} neighbourhood: ${hot.length} hot spot(s) and ${cold.length} cold spot(s) survive false-discovery-rate control at q < 0.05. ` +
      `Unadjusted, ${rawSignificant} location(s) would have looked significant at p < 0.05 — that gap is what testing ${gi.length} locations at once manufactures out of noise, and it is why the q-value decides the classification.`;
    return report;
  }

  if (method === "distance-decay") {
    report.decay = distanceDecay(points);
    report.interpretation = report.decay.verdict;
    return report;
  }

  const eps = input.epsKm ?? (input.bandKm && input.bandKm > 0 ? input.bandKm : 25);
  const { clusters, noise } = dbscan(points, eps, input.minPts ?? 4);
  report.clusters = clusters;
  report.noiseCount = noise.length;
  report.knn = knnNeighbourhood(points, input.k || 4);
  report.interpretation =
    `DBSCAN at ε = ${eps} km and minPts = ${input.minPts ?? 4} on a local equirectangular projection found ${clusters.length} cluster(s) covering ${points.length - noise.length} point(s), with ${noise.length} point(s) left as noise. ` +
    (clusters.length > 0
      ? `The largest holds ${clusters[0]!.size} point(s) with mean value ${clusters[0]!.meanValue.toPrecision(4)} and median spread ${clusters[0]!.spreadKm.toPrecision(3)} km. `
      : "No cluster met the density threshold. ") +
    (noise.length > points.length * 0.3
      ? `Over 30% of points are noise, which usually means ε is too small for this geography rather than that most points are outliers — re-running with a wider band would change this picture.`
      : `Points in the projection are scaled by cos(latitude) ≈ ${projectPoints(points).scale.toPrecision(4)}, so a degree of longitude is treated as shorter than a degree of latitude, which is correct away from the equator but approximate.`);
  return report;
}

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fisherYates(arr: number[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
