import {
  benjaminiHochberg,
  buildNeighbourhood,
  dbscan,
  distanceDecay,
  getisOrdGiStar,
  haversineKm,
  isValidCoordinate,
  knnNeighbourhood,
  moransI,
  mulberry32,
  pointInPolygon,
  projectPoints,
  runGeospatialAnalysis,
  spatialJoin,
  toRadians,
  GeospatialError,
  type GeoPoint,
} from "@/lib/engine/geospatial";

const G = 12;
const STEP = 0.02; // ~1.4 km of longitude at 51.5° N

function lattice(value: (i: number, j: number) => number): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) out.push({ id: `${i}-${j}`, lat: 51.5 + j * STEP, lon: i * STEP, value: value(i, j) });
  }
  return out;
}

/** A surface of genuinely random values, so the null hypothesis is actually null. */
function randomSurface(seed: number): GeoPoint[] {
  const rng = mulberry32(seed);
  return lattice(() => rng() * 100);
}

describe("geospatial: distance", () => {
  it("matches published great-circle distances", () => {
    // London–Paris and London–Sydney are standard haversine test vectors.
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeCloseTo(343.6, 0);
    expect(haversineKm(51.5074, -0.1278, -33.8688, 151.2093)).toBeCloseTo(16994, 0);
  });

  it("is zero for a point against itself", () => {
    expect(haversineKm(51.5, -0.1, 51.5, -0.1)).toBeCloseTo(0, 9);
  });

  it("is symmetric", () => {
    expect(haversineKm(10, 20, -30, 100)).toBeCloseTo(haversineKm(-30, 100, 10, 20), 9);
  });

  it("converts degrees to radians", () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toRadians(0)).toBe(0);
  });

  it("validates coordinate ranges, not just finiteness", () => {
    expect(isValidCoordinate(51.5, -0.1)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
    expect(isValidCoordinate("51.5", 0)).toBe(false);
  });
});

describe("geospatial: neighbourhood", () => {
  it("finds band neighbours and excludes the point itself", () => {
    const pts = lattice((i, j) => i + j);
    const nb = buildNeighbourhood(pts, { bandKm: 3 });
    expect(nb.kind).toBe("band");
    expect(nb.indices[0]).not.toContain(0);
    expect(nb.indices[0]!.length).toBeGreaterThan(0);
  });

  it("symmetrises a k-nearest graph", () => {
    const pts = lattice((i, j) => i + j);
    const nb = buildNeighbourhood(pts, { k: 3 });
    for (let i = 0; i < pts.length; i++) {
      for (const j of nb.indices[i]!) {
        expect(nb.indices[j]).toContain(i);
      }
    }
  });

  it("row-standardises so every row sums to one", () => {
    const nb = buildNeighbourhood(
      lattice(() => 1),
      { bandKm: 3 },
    );
    for (const row of nb.weights) {
      if (row.length === 0) continue;
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });

  it("reports points with no neighbour instead of silently dropping them", () => {
    const far: GeoPoint[] = [
      { id: "a", lat: 0, lon: 0, value: 1 },
      { id: "b", lat: 60, lon: 120, value: 1 },
    ];
    const nb = buildNeighbourhood(far, { bandKm: 10 });
    expect(nb.isolated).toEqual([0, 1]);
    expect(nb.indices[0]).toEqual([]);
  });

  it("weights closer neighbours more heavily under inverse-distance", () => {
    const pts = lattice((i) => i);
    const nb = buildNeighbourhood(pts, { bandKm: 3, power: 1 });
    // For point 0 the nearest neighbour should carry the largest weight.
    const w = nb.weights[0]!;
    expect(Math.max(...w)).toBe(w[0]);
  });

  it("requires either a band or a k", () => {
    expect(() =>
      buildNeighbourhood(
        lattice(() => 1),
        {},
      ),
    ).toThrow(GeospatialError);
    expect(() => buildNeighbourhood([], { bandKm: 5 })).toThrow(GeospatialError);
  });
});

describe("geospatial: Moran's I", () => {
  it("detects a contiguous high block as clustering", () => {
    const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));
    const result = moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 999, 7);
    expect(result.statistic).toBeGreaterThan(0);
    expect(result.pattern).toBe("clustered");
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("detects a checkerboard as dispersion", () => {
    const pts = lattice((i, j) => ((i + j) % 2 === 0 ? 100 : 0));
    const result = moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 999, 7);
    expect(result.statistic).toBeLessThan(0);
    expect(result.pattern).toBe("dispersed");
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("reports the expected value of −1/(n−1) under spatial randomness", () => {
    const pts = lattice((i, j) => i + j);
    const n = pts.length;
    expect(moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 99).expected).toBeCloseTo(-1 / (n - 1), 12);
  });

  it("uses the cross-product term, not the spatial lag", () => {
    // With row-standardised weights Σⱼwᵢⱼ = 1 and Σᵢzᵢ = 0, so the lag Σⱼwᵢⱼzⱼ
    // sums to zero on any regular grid. A statistic computed from the lag would
    // report exactly 0 for every surface, including a blatant cluster.
    const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));
    const result = moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 199, 7);
    expect(Math.abs(result.statistic)).toBeGreaterThan(0.05);
  });

  it("produces p-values close to uniform on genuinely random surfaces", () => {
    const ps: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const pts = randomSurface(seed);
      ps.push(moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 199, seed).pValue);
    }
    // A null-calibrated test should reject rarely. With 10 draws, zero or one
    // rejection at 0.05 is expected; more would mean the null is mis-specified.
    expect(ps.filter((p) => p < 0.05).length).toBeLessThanOrEqual(2);
    for (const p of ps) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the analytic standard deviation consistent with the permutation null", () => {
    // The permutation sd is measured directly below; the analytic formula must
    // agree with it rather than being off by orders of magnitude.
    const pts = randomSurface(1);
    const nb = buildNeighbourhood(pts, { bandKm: 2.5 });
    const result = moransI(pts, nb, 3999, 1);
    const permutationSd = permutationSdOf(pts, nb, 1, 4000);
    expect(Math.sqrt(result.variance)).toBeGreaterThan(permutationSd * 0.5);
    expect(Math.sqrt(result.variance)).toBeLessThan(permutationSd * 2);
  });

  it("agrees with the permutation z-sign on a clustered surface", () => {
    const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));
    const result = moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 999, 7);
    expect(result.zScore).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("says so plainly when no permutations were run", () => {
    const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));
    const result = moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 0);
    expect(Number.isNaN(result.pValue)).toBe(true);
    expect(result.verdict).toMatch(/no permutations were run/);
  });

  it("refuses a constant surface and an empty neighbourhood", () => {
    const flat = lattice(() => 5);
    expect(() => moransI(flat, buildNeighbourhood(flat, { bandKm: 2.5 }), 99)).toThrow(/same value/);
    const scattered: GeoPoint[] = [
      { id: "a", lat: 0, lon: 0, value: 1 },
      { id: "b", lat: 45, lon: 90, value: 2 },
      { id: "c", lat: -45, lon: -90, value: 3 },
    ];
    expect(() => moransI(scattered, buildNeighbourhood(scattered, { bandKm: 1 }), 99)).toThrow(
      /neighbourhood is empty/,
    );
  });

  it("needs at least three points", () => {
    const two: GeoPoint[] = [
      { id: "a", lat: 0, lon: 0, value: 1 },
      { id: "b", lat: 0.01, lon: 0, value: 2 },
    ];
    expect(() => moransI(two, buildNeighbourhood(two, { bandKm: 5 }), 99)).toThrow(/at least 3 points/);
  });

  it("labels a random surface as random, not as clustered", () => {
    // The sign of I on a random surface is a coin flip; calling every positive
    // value "clustered" reports noise as structure.
    const signs = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const pts = randomSurface(seed);
      signs.add(moransI(pts, buildNeighbourhood(pts, { bandKm: 2.5 }), 199, seed).pattern);
    }
    expect(signs.has("random")).toBe(true);
  });

  it("is deterministic for a fixed seed and reproducible across repeats", () => {
    const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));
    const nb = buildNeighbourhood(pts, { bandKm: 2.5 });
    expect(moransI(pts, nb, 999, 11)).toEqual(moransI(pts, nb, 999, 11));
  });

  it("changes with a different permutation seed, so the null is real", () => {
    const pts = randomSurface(2);
    const nb = buildNeighbourhood(pts, { bandKm: 2.5 });
    const a = moransI(pts, nb, 199, 1);
    const b = moransI(pts, nb, 199, 99);
    expect(a.statistic).toBe(b.statistic);
    expect(a.pValue).not.toBe(b.pValue);
  });
});

/** Empirical sd of I under the permutation null, computed independently of the engine. */
function permutationSdOf(
  points: GeoPoint[],
  nb: ReturnType<typeof buildNeighbourhood>,
  seed: number,
  draws: number,
): number {
  const n = points.length;
  const mean = points.reduce((a, p) => a + p.value, 0) / n;
  const dev = points.map((p) => p.value - mean);
  const zSq = dev.reduce((a, b) => a + b * b, 0);
  const s0 = nb.indices.reduce((a, row) => a + row.length, 0);
  const stat = (d: number[]): number => {
    let num = 0;
    for (let i = 0; i < n; i++) {
      let local = 0;
      for (let k = 0; k < nb.indices[i]!.length; k++) local += nb.weights[i]![k]! * d[nb.indices[i]![k]!]!;
      num += d[i]! * local;
    }
    return (n / s0) * (num / zSq);
  };
  const rng = mulberry32(seed);
  const perm = dev.slice();
  const out: number[] = [];
  for (let r = 0; r < draws; r++) {
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = perm[i]!;
      perm[i] = perm[j]!;
      perm[j] = t;
    }
    out.push(stat(perm));
  }
  const m = out.reduce((a, b) => a + b, 0) / out.length;
  return Math.sqrt(out.reduce((a, b) => a + (b - m) ** 2, 0) / (out.length - 1));
}

describe("geospatial: Getis-Ord Gi*", () => {
  it("finds a high-value block and calls it a hot spot", () => {
    const pts = lattice((i, j) => (i >= 4 && i < 9 && j >= 4 && j < 9 ? 100 : 0));
    const gi = getisOrdGiStar(pts, buildNeighbourhood(pts, { bandKm: 2.5 }));
    const hot = gi.filter((g) => g.classification === "hot-spot");
    expect(hot.length).toBeGreaterThan(0);
    for (const h of hot) {
      expect(h.zScore).toBeGreaterThan(0);
      expect(h.qValue).toBeLessThan(0.05);
    }
  });

  it("lets FDR control shrink the count below the raw p-value threshold", () => {
    // Testing 196 locations at p < 0.05 marks ~10 of them on pure noise; the
    // classification must be driven by the q-value instead.
    const pts = randomSurface(5);
    const gi = getisOrdGiStar(pts, buildNeighbourhood(pts, { bandKm: 2.5 }));
    const raw = gi.filter((g) => g.rawPValue < 0.05).length;
    const adjusted = gi.filter((g) => g.classification !== "not-significant").length;
    expect(adjusted).toBeLessThanOrEqual(raw);
  });

  it("finds a low-value block as a cold spot", () => {
    const pts = lattice((i, j) => (i >= 4 && i < 9 && j >= 4 && j < 9 ? 0 : 100));
    const gi = getisOrdGiStar(pts, buildNeighbourhood(pts, { bandKm: 2.5 }));
    expect(gi.filter((g) => g.classification === "cold-spot").length).toBeGreaterThan(0);
    for (const c of gi.filter((g) => g.classification === "cold-spot")) expect(c.zScore).toBeLessThan(0);
  });

  it("calls a flat surface entirely insignificant", () => {
    // Every z-score is 0 by construction; marking any of them significant would
    // be an artefact of the standardisation, not evidence of a pattern.
    const gi = getisOrdGiStar(
      lattice(() => 5),
      buildNeighbourhood(
        lattice(() => 5),
        { bandKm: 2.5 },
      ),
    );
    expect(gi.every((g) => g.zScore === 0)).toBe(true);
    expect(gi.every((g) => g.classification === "not-significant")).toBe(true);
  });

  it("needs at least two points", () => {
    expect(() =>
      getisOrdGiStar(
        [{ id: "a", lat: 0, lon: 0, value: 1 }],
        buildNeighbourhood(
          [
            { id: "a", lat: 0, lon: 0, value: 1 },
            { id: "b", lat: 1, lon: 1, value: 2 },
          ],
          { bandKm: 200 },
        ),
      ),
    ).toThrow(GeospatialError);
  });

  it("matches the Ord-Getis formula computed independently", () => {
    const pts = lattice((i, j) => (i < 4 && j < 4 ? 100 : 0));
    const nb = buildNeighbourhood(pts, { bandKm: 2.5 });
    const gi = getisOrdGiStar(pts, nb);

    const n = pts.length;
    const mean = pts.reduce((a, p) => a + p.value, 0) / n;
    const sd = Math.sqrt(pts.reduce((a, p) => a + (p.value - mean) ** 2, 0) / n);
    for (const i of [0, 50, n - 1]) {
      const row = nb.weights[i]!;
      const sumW = row.reduce((a, w) => a + w, 0);
      const sumW2 = row.reduce((a, w) => a + w * w, 0);
      const local = row.reduce((a, w, t) => a + w * pts[nb.indices[i]![t]!]!.value, 0);
      const expected = (local - mean * sumW) / (sd * Math.sqrt((n * sumW2 - sumW * sumW) / (n - 1)));
      expect(gi[i]!.zScore).toBeCloseTo(expected, 12);
    }
  });

  it("keeps raw p-values uniform on a genuinely random surface", () => {
    // This is the real check on the z-score: under spatial randomness the p-value
    // should be uniform, so ~5% of locations should clear 0.05. A formula that
    // drops the X̄Σw correction, or that divides by the wrong variance, inflates
    // this rate sharply.
    const pts = randomSurface(5);
    const gi = getisOrdGiStar(pts, buildNeighbourhood(pts, { bandKm: 2.5 }));
    const rate = gi.filter((g) => g.rawPValue < 0.05).length / gi.length;
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.09);
  });
});

describe("geospatial: Benjamini-Hochberg", () => {
  it("scales a p-value by rank and divides by m", () => {
    expect(benjaminiHochberg([0.01])[0]).toBeCloseTo(0.01, 12);
    expect(benjaminiHochberg([0.01, 0.02])[0]).toBeCloseTo(0.02, 12);
  });

  it("is monotone in the sorted order and respects input order", () => {
    const sorted = benjaminiHochberg([0.001, 0.01, 0.02, 0.5, 0.9]);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!).toBeGreaterThanOrEqual(sorted[i - 1]!);
    const reversed = benjaminiHochberg([0.9, 0.5, 0.02, 0.01, 0.001]);
    expect(reversed).toEqual(sorted.slice().reverse());
  });

  it("never returns a q-value below its p-value", () => {
    const q = benjaminiHochberg([0.002, 0.03, 0.2, 0.4, 0.7]);
    for (const v of q) expect(v).toBeGreaterThanOrEqual(v);
    const ps = [0.002, 0.03, 0.2, 0.4, 0.7];
    ps.forEach((p, i) => expect(q[i]!).toBeGreaterThanOrEqual(p));
  });

  it("caps at one and handles an empty list", () => {
    // q = min(1, p·m/rank); at the largest rank m/rank = 1, so a p-value below 1
    // is scaled rather than inflated, and 1.0 is the ceiling.
    expect(benjaminiHochberg([0.99, 0.99])[1]).toBeCloseTo(0.99, 12);
    expect(benjaminiHochberg([0.5, 1])[1]).toBeCloseTo(1, 12);
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe("geospatial: distance decay", () => {
  it("finds a negative slope when interaction falls off with distance", () => {
    // A hub with value 1 and spokes whose value decays with their own distance
    // from the hub: every pair's geometric mean then declines with pair distance.
    const pts: GeoPoint[] = [{ id: "hub", lat: 50, lon: 0, value: 1 }];
    for (let k = 1; k <= 15; k++) {
      const d = k * 10;
      pts.push({ id: `s${k}`, lat: 50 + d / 111.32, lon: 0, value: 100 / (1 + d / 50) });
    }
    const result = distanceDecay(pts);
    expect(result.slope).toBeLessThan(0);
    expect(result.halfLifeKm).not.toBeNull();
    expect(result.n).toBeGreaterThan(50);
  });

  it("reports a near-zero slope and no half-life on a flat surface", () => {
    const pts: GeoPoint[] = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      lat: 50 + i * 0.02,
      lon: 0,
      value: 7,
    }));
    const result = distanceDecay(pts);
    expect(Math.abs(result.slope)).toBeLessThan(1e-9);
    expect(result.halfLifeKm).toBeNull();
    expect(result.verdict).toMatch(/does not exhibit distance decay/);
  });

  it("warns about a weak fit rather than presenting a half-life as fact", () => {
    const pts: GeoPoint[] = [{ id: "hub", lat: 50, lon: 0, value: 1 }];
    for (let k = 1; k <= 15; k++) {
      const d = k * 10;
      pts.push({ id: `s${k}`, lat: 50 + d / 111.32, lon: 0, value: 100 / (1 + d / 50) });
    }
    const result = distanceDecay(pts);
    expect(result.rSquared).toBeLessThan(1);
    expect(result.verdict).toMatch(/R²/);
  });

  it("excludes non-positive values and coincident points, and counts them", () => {
    const pts: GeoPoint[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      lat: 50 + i * 0.02,
      lon: 0,
      value: i % 4 === 0 ? -1 : 5,
    }));
    pts.push({ id: "twin", lat: 50, lon: 0, value: 5 });
    const result = distanceDecay(pts);
    expect(result.verdict).toMatch(/excluded for a non-positive value/);
    expect(result.verdict).toMatch(/coincident locations/);
  });

  it("refuses when too few pairs survive", () => {
    const pts: GeoPoint[] = [
      { id: "a", lat: 50, lon: 0, value: -1 },
      { id: "b", lat: 51, lon: 0, value: -2 },
    ];
    expect(() => distanceDecay(pts)).toThrow(/at least 3 usable pairs/);
  });

  it("honours a pair cap rather than silently running unbounded", () => {
    const pts: GeoPoint[] = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      lat: 50 + i * 0.01,
      lon: 0,
      value: 10 - i * 0.1,
    }));
    expect(distanceDecay(pts, { maxPairs: 10 }).n).toBeLessThanOrEqual(10);
  });
});

describe("geospatial: projection and DBSCAN", () => {
  const pts: GeoPoint[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, lat: 52 + i * 0.005, lon: 1 + i * 0.005, value: 5 })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, lat: 53 + i * 0.005, lon: 1 + i * 0.005, value: 7 })),
    { id: "out", lat: 55, lon: 5, value: 99 },
  ];

  it("scales longitude by cos(latitude)", () => {
    const { scale } = projectPoints([
      { id: "a", lat: 60, lon: 0, value: 1 },
      { id: "b", lat: 60, lon: 1, value: 1 },
    ]);
    expect(scale).toBeCloseTo(0.5, 6);
  });

  it("finds two dense groups and leaves the stray point as noise", () => {
    const result = dbscan(pts, 20, 3);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]!.size).toBe(6);
    expect(result.clusters[1]!.size).toBe(5);
    expect(result.noise).toEqual([11]);
    expect(result.clusters.reduce((a, c) => a + c.size, 0)).toBe(11);
  });

  it("labels a location consistent with its own value", () => {
    const result = dbscan(pts, 20, 3);
    const a = result.clusters.find((c) => c.members.includes(0))!;
    const b = result.clusters.find((c) => c.members.includes(6))!;
    expect(a.meanValue).toBeCloseTo(5, 12);
    expect(b.meanValue).toBeCloseTo(7, 12);
  });

  it("reports a tight spread for a tight cluster", () => {
    const result = dbscan(pts, 20, 3);
    expect(result.clusters[0]!.spreadKm).toBeLessThan(2);
  });

  it("finds nothing when epsilon is too small to see any density", () => {
    const result = dbscan(pts, 0.01, 3);
    expect(result.clusters).toHaveLength(0);
    expect(result.noise).toHaveLength(12);
  });

  it("merges everything when epsilon is huge", () => {
    const result = dbscan(pts, 5000, 2);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.size).toBe(12);
  });

  it("rejects a non-positive epsilon and a zero minPts", () => {
    expect(() => dbscan(pts, 0, 3)).toThrow(GeospatialError);
    expect(() => dbscan(pts, 10, 0)).toThrow(GeospatialError);
  });
});

describe("geospatial: k-nearest neighbours", () => {
  it("orders neighbours by distance and reports the spatial lag", () => {
    const pts: GeoPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      lat: 50 + i * 0.02,
      lon: 0,
      value: i,
    }));
    const result = knnNeighbourhood(pts, 3);
    const first = result[0]!;
    expect(first.neighbours.map((n) => n.id)).toEqual(["p1", "p2", "p3"]);
    for (let i = 1; i < first.neighbours.length; i++) {
      expect(first.neighbours[i]!.distanceKm).toBeGreaterThanOrEqual(first.neighbours[i - 1]!.distanceKm);
    }
    expect(first.meanNeighbourValue).toBeCloseTo(2, 12);
  });

  it("contrasts a local value against the global mean", () => {
    // Values rise with latitude, so the southernmost points sit among
    // below-average neighbours and the northernmost among above-average ones.
    const pts: GeoPoint[] = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      lat: 50 + i * 0.02,
      lon: 0,
      value: i,
    }));
    const result = knnNeighbourhood(pts, 3);
    const globalMean = 4.5;
    expect(result[0]!.meanNeighbourValue).toBeCloseTo(2, 12);
    expect(result[0]!.contrast).toBeCloseTo(2 - globalMean, 12);
    expect(result[9]!.contrast).toBeCloseTo(7 - globalMean, 12);
    expect(result[0]!.contrast).toBeLessThan(0);
    expect(result[9]!.contrast).toBeGreaterThan(0);
  });

  it("never lists a point as its own neighbour", () => {
    const result = knnNeighbourhood(
      lattice(() => 1),
      4,
    );
    for (const r of result) expect(r.neighbours.map((n) => n.id)).not.toContain(r.id);
  });

  it("rejects a non-positive k", () => {
    expect(() =>
      knnNeighbourhood(
        lattice(() => 1),
        0,
      ),
    ).toThrow(GeospatialError);
  });
});

describe("geospatial: spatial join", () => {
  const box = { region: "box", lat: [50, 52, 52, 50], lon: [0, 0, 1, 1] };

  it("assigns points inside and outside a polygon", () => {
    expect(pointInPolygon(51, 0.5, box)).toBe(true);
    expect(pointInPolygon(53, 0.5, box)).toBe(false);
    expect(pointInPolygon(51, 5, box)).toBe(false);
  });

  it("assigns each point to exactly one region", () => {
    // `box` and `overlap` both contain point a, so a naive join would count it
    // twice; point b lies inside neither.
    const overlapping = { region: "overlap", lat: [49, 53, 53, 49], lon: [-1, -1, 2, 2] };
    const result = spatialJoin(
      [
        { id: "a", lat: 51, lon: 0.5, value: 10 },
        { id: "b", lat: 60, lon: 5, value: 1 },
      ],
      [box, overlapping],
    );
    expect(result[0]!.count).toBe(1);
    expect(result[1]!.count).toBe(0);
    expect(result.reduce((a, r) => a + r.count, 0)).toBe(1);
  });

  it("surfaces regions that received no points", () => {
    const result = spatialJoin(
      [{ id: "a", lat: 51, lon: 0.5, value: 10 }],
      [box, { region: "empty", lat: [0, 1, 1, 0], lon: [100, 100, 101, 101] }],
    );
    const empty = result.find((r) => r.region === "empty")!;
    expect(empty.empty).toBe(true);
    expect(empty.count).toBe(0);
    expect(empty.meanValue).toBe(0);
  });

  it("handles a polygon that straddles the antimeridian", () => {
    // 179°E to 179°W is a 2° strip across the date line. Wrapping each vertex
    // independently turns it into a 358° band that swallows most of the Pacific.
    const dateline = { region: "dateline", lat: [-10, -10, 10, 10], lon: [179, -179, -179, 179] };
    expect(pointInPolygon(0, 179.5, dateline)).toBe(true);
    expect(pointInPolygon(0, -179.5, dateline)).toBe(true);
    expect(pointInPolygon(0, 180, dateline)).toBe(true);
    expect(pointInPolygon(0, 178, dateline)).toBe(false);
    expect(pointInPolygon(0, -178, dateline)).toBe(false);
    expect(pointInPolygon(0, 0, dateline)).toBe(false);
    expect(pointInPolygon(80, 179.5, dateline)).toBe(false);
  });

  it("gives the same answer with equivalent longitude spellings", () => {
    const a = { region: "a", lat: [0, 0, 10, 10], lon: [-179, -178, -178, -179] };
    const b = { region: "b", lat: [0, 0, 10, 10], lon: [181, 182, 182, 181] };
    for (const lat of [1, 5, 9]) {
      for (const lon of [-179.5, -178.5, -178.1]) {
        expect(pointInPolygon(lat, lon, b)).toBe(pointInPolygon(lat, lon, a));
      }
    }
  });

  it("ignores a degenerate ring with fewer than three vertices", () => {
    expect(pointInPolygon(1, 1, { region: "degenerate", lat: [0, 10], lon: [0, 1] })).toBe(false);
    expect(pointInPolygon(1, 1, { region: "mismatch", lat: [0, 0, 1], lon: [0, 1] })).toBe(false);
  });

  it("averages values per region", () => {
    const result = spatialJoin(
      [
        { id: "a", lat: 50.5, lon: 0.5, value: 10 },
        { id: "b", lat: 51.5, lon: 0.5, value: 20 },
      ],
      [box],
    );
    expect(result[0]!.meanValue).toBeCloseTo(15, 12);
    expect(result[0]!.count).toBe(2);
  });
});

describe("geospatial: top-level report", () => {
  const pts = lattice((i, j) => (i < 5 && j < 5 ? 100 : 0));

  it("runs Moran's I and reports the permutation evidence", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "morans-i", bandKm: 2.5, permutations: 499 });
    expect(report.moransI).toBeDefined();
    expect(report.moransI!.pValue).toBeLessThan(0.05);
    expect(report.interpretation).toMatch(/treating these values as independent/);
  });

  it("runs Gi* and explains the multiplicity adjustment", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "getis-ord", bandKm: 2.5 });
    expect(report.giStar).toHaveLength(pts.length);
    expect(report.interpretation).toMatch(/false-discovery-rate/);
  });

  it("treats hotspots as Gi*", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "hotspots", bandKm: 2.5 });
    expect(report.giStar).toBeDefined();
  });

  it("runs distance decay", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "distance-decay" });
    expect(report.decay).toBeDefined();
    expect(report.decay!.n).toBeGreaterThan(0);
  });

  it("runs clustering with a k-NN summary", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "clusters", epsKm: 4, minPts: 3 });
    expect(report.clusters!.length).toBeGreaterThan(0);
    expect(report.knn).toHaveLength(pts.length);
    expect(report.noiseCount).toBeGreaterThanOrEqual(0);
    expect(report.interpretation).toMatch(/cos\(latitude\)/);
  });

  it("warns when a lot of points are noise, because epsilon is probably wrong", () => {
    const report = runGeospatialAnalysis({ points: pts, method: "clusters", epsKm: 0.05, minPts: 8 });
    expect(report.interpretation).toMatch(/ε is too small/);
  });

  it("warns about isolated points rather than silently excluding them", () => {
    const withIsolate: GeoPoint[] = [
      { id: "a", lat: 0, lon: 0, value: 1 },
      { id: "b", lat: 0.005, lon: 0, value: 2 },
      { id: "c", lat: 0.01, lon: 0, value: 3 },
      { id: "far", lat: 60, lon: 120, value: 4 },
    ];
    const report = runGeospatialAnalysis({ points: withIsolate, method: "morans-i", bandKm: 2, permutations: 99 });
    expect(report.warnings.join(" ")).toMatch(/no neighbour/);
  });

  it("rejects invalid coordinates and non-finite values", () => {
    expect(() =>
      runGeospatialAnalysis({
        points: [
          { id: "bad", lat: 100, lon: 0, value: 1 },
          { id: "ok", lat: 0, lon: 0, value: 1 },
        ],
        method: "morans-i",
        bandKm: 5,
      }),
    ).toThrow(GeospatialError);
    expect(() =>
      runGeospatialAnalysis({
        points: [
          { id: "bad", lat: 0, lon: 0, value: Number.NaN },
          { id: "ok", lat: 0.01, lon: 0, value: 1 },
        ],
        method: "morans-i",
        bandKm: 5,
      }),
    ).toThrow(/non-finite/);
  });

  it("needs at least two points", () => {
    expect(() =>
      runGeospatialAnalysis({ points: [{ id: "a", lat: 0, lon: 0, value: 1 }], method: "morans-i", bandKm: 5 }),
    ).toThrow(/at least 2 points/);
  });

  it("is deterministic for identical input", () => {
    const input = { points: pts, method: "morans-i" as const, bandKm: 2.5, permutations: 199, seed: 5 };
    expect(runGeospatialAnalysis(input)).toEqual(runGeospatialAnalysis(input));
  });
});

describe("geospatial: seeded RNG", () => {
  it("produces a repeatable stream in [0, 1)", () => {
    const a = mulberry32(3);
    const b = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("diverges for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});
