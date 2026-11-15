/**
 * Unit tests for the conformal prediction interval engine
 * (lib/engine/conformal.ts).
 *
 * Oracles:
 *  - COVERAGE: on iid normal data, a 90% conformal interval must cover at
 *    least ~88% of held-out points (the guarantee is ≥ 1−α exchangeable, so a
 *    large-sample empirical check with slack is a sound smoke test);
 *  - EXACTNESS: the quantile equals the ⌈(n+1)(1−α)⌉-th smallest score;
 *  - DETERMINISM: same inputs ⇒ identical half-width;
 *  - HONESTY: degenerate inputs throw readable errors instead of inventing
 *    intervals.
 */
import { calibrateConformal, conformalQuantile, calibrationSplit, ConformalError } from "@/lib/engine/conformal";
import { seededRandom } from "@/lib/engine/ml-training";

/** Box–Muller normal from the repo's seeded PRNG (deterministic). */
function normals(n: number, seed: number, mu = 0, sigma = 1): number[] {
  const rand = seededRandom(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.push(mu + sigma * z);
  }
  return out;
}

describe("conformalQuantile", () => {
  it("returns the ⌈(n+1)(1−α)⌉-th smallest score (exact rank oracle)", () => {
    const scores = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99
    // α=0.05 → rank = ⌈100·0.95⌉ = 95 → the 95th smallest score = 95.
    expect(conformalQuantile(scores, 0.05)).toBe(95);
    // α=0.1 → rank = ⌈100·0.9⌉ = 90.
    expect(conformalQuantile(scores, 0.1)).toBe(90);
  });

  it("is deterministic — same scores + alpha ⇒ identical quantile", () => {
    const scores = normals(200, 7, 0, 1).map(Math.abs);
    const a = conformalQuantile(scores, 0.1);
    const b = conformalQuantile(scores, 0.1);
    expect(a).toBe(b);
  });

  it("rejects empty/degenerate inputs with readable errors", () => {
    expect(() => conformalQuantile([], 0.1)).toThrow(ConformalError);
    expect(() => conformalQuantile([1, 2, 3], 0)).toThrow(ConformalError);
    expect(() => conformalQuantile([1, 2, 3], 1.5)).toThrow(ConformalError);
    expect(() => conformalQuantile([NaN, Infinity], 0.1)).toThrow(ConformalError);
  });
});

describe("calibrateConformal — coverage oracle", () => {
  it("90% intervals achieve ≥ 90% coverage on average over calibration draws", () => {
    // The conformal guarantee is MARGINAL over the calibration sample: for a
    // single draw the realized quantile can sit low (finite-sample noise), so
    // the honest oracle averages coverage over many INDEPENDENT calibration
    // draws against fresh test points — exactly the quantity the theorem
    // bounds (P(new score ≤ q̂) ≥ 1−α over both draws).
    const rand = seededRandom(42);
    const noise = () => Math.abs((rand() * 2 - 1) * 12); // |e| ~ Uniform[0,12]
    const nCal = 400;
    const nTest = 500;
    const draws = 40;
    let totalCovered = 0;
    let totalPoints = 0;
    let lastCal: ReturnType<typeof calibrateConformal> | null = null;
    for (let d = 0; d < draws; d++) {
      const y: number[] = [];
      const pred: number[] = [];
      for (let i = 0; i < nCal + nTest; i++) {
        const e = noise();
        y.push(50 + e); // truth + noise; the model's error is e
        pred.push(50); // point prediction (oracle mean) — residual = e
      }
      const cal = calibrateConformal(y.slice(0, nCal), pred.slice(0, nCal), 0.1);
      lastCal = cal;
      const testCovered = y
        .slice(nCal)
        .map((yt) => Math.abs(yt - 50))
        .filter((s) => s <= cal.halfWidth).length;
      totalCovered += testCovered;
      totalPoints += nTest;
    }
    const meanCoverage = totalCovered / totalPoints;
    expect(meanCoverage).toBeGreaterThanOrEqual(0.895); // ≥ 1−α with tiny MC slack
    // Provenance fields are per-draw honest.
    expect(lastCal!.nCalibration).toBe(nCal);
    expect(lastCal!.coverageOnCalibration).toBeGreaterThanOrEqual(0.9);
    expect(lastCal!.methodology).toContain("Split-conformal");
  });

  it("drops non-finite predictions honestly and reports the count", () => {
    const y = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const pred = [1.1, 2.2, 3.1, 4.2, 5.1, 6.2, 7.1, 8.2, 9.1, Number.NaN];
    const cal = calibrateConformal(y, pred, 0.2);
    expect(cal.nCalibration).toBe(9);
    expect(cal.methodology).toContain("1 row(s)");
  });

  it("refuses to invent an interval with too few scored rows", () => {
    expect(() => calibrateConformal([1, 2, 3], [1, 2, 3], 0.1)).toThrow(ConformalError);
  });

  it("is deterministic — same data + alpha ⇒ identical half-width", () => {
    const y = normals(120, 5, 10, 2);
    const p = normals(120, 6, 10.3, 2);
    expect(calibrateConformal(y, p, 0.1).halfWidth).toBe(calibrateConformal(y, p, 0.1).halfWidth);
  });
});

describe("calibrationSplit", () => {
  it("assigns the requested fraction (bounded 10–50%) deterministically", () => {
    const n = 100;
    const a = calibrationSplit(n, 0.25, seededRandom(9));
    const b = calibrationSplit(n, 0.25, seededRandom(9));
    expect(a).toEqual(b); // same seed ⇒ same split
    const count = a.filter(Boolean).length;
    expect(count).toBe(25);
    const small = calibrationSplit(10, 0.9, seededRandom(1));
    expect(small.filter(Boolean).length).toBe(5); // clamped to 0.5
  });
});
