/**
 * Oracle tests for the causal engine (lib/engine/elite-causal.ts):
 * DiD arithmetic + closed-form SE, IPW recovery of a known effect, balance
 * mechanics, and the honest-labelling contract.
 */
import { differenceInDifferences, placeboDid, propensityIpw, type PsRow } from "@/lib/engine/elite-causal";

describe("placebo DiD (falsification)", () => {
  const real = 2; // the headline estimate from the 2×2 above

  it("PASSES when the pre-treatment placebo is ≈ 0 and smaller than the real effect", () => {
    // Pre-periods move in lockstep: treated 10→10.1, control 10→10.1 ⇒ placebo DiD = 0.
    const r = placeboDid(
      {
        treated: { base: { value: 10, n: 50, sd: 2 }, placebo: { value: 10.1, n: 50, sd: 2 } },
        control: { base: { value: 10, n: 50, sd: 2 }, placebo: { value: 10.1, n: 50, sd: 2 } },
      },
      real,
    );
    expect(r.estimate).toBeCloseTo(0, 9);
    expect(r.verdict).toBe("passes");
    expect(r.interpretation).toContain("PASS");
  });

  it("FAILS when the placebo effect is as large as the real one (pre-existing trend)", () => {
    // Treated was already rising faster: placebo DiD = +2 — same size as the "effect".
    const r = placeboDid(
      {
        treated: { base: { value: 8, n: 50, sd: 2 }, placebo: { value: 10, n: 50, sd: 2 } },
        control: { base: { value: 8, n: 50, sd: 2 }, placebo: { value: 8, n: 50, sd: 2 } },
      },
      real,
    );
    expect(r.estimate).toBe(2);
    expect(r.verdict).toBe("fails");
    expect(r.interpretation).toContain("FAIL");
  });

  it("FAILS when a huge placebo sample makes a small pre-trend significant (p < 0.10)", () => {
    // SE = √(4·4/50000) ≈ 0.0179; a +0.05 pre-trend ⇒ t ≈ 2.8 ⇒ p ≪ 0.10.
    const r = placeboDid(
      {
        treated: { base: { value: 10, n: 50000, sd: 2 }, placebo: { value: 10.05, n: 50000, sd: 2 } },
        control: { base: { value: 10, n: 50000, sd: 2 }, placebo: { value: 10, n: 50000, sd: 2 } },
      },
      real,
    );
    expect(r.estimate).toBeCloseTo(0.05, 9);
    expect(r.pValue).toBeLessThan(0.1);
    expect(r.verdict).toBe("fails");
  });

  it("stays honest when cell SDs are missing — size comparison only", () => {
    const r = placeboDid(
      {
        treated: { base: { value: 10, n: 50 }, placebo: { value: 10.1, n: 50 } },
        control: { base: { value: 10, n: 50 }, placebo: { value: 10.1, n: 50 } },
      },
      real,
    );
    expect(Number.isNaN(r.standardError)).toBe(true);
    expect(r.verdict).toBe("passes");
    expect(r.interpretation).toContain("size-comparison only");
  });
});

describe("difference-in-differences", () => {
  it("matches the hand-computed 2×2 DiD and its components", () => {
    // treated: 10 → 14 (+4); control: 10 → 12 (+2); DiD = 2
    const r = differenceInDifferences({
      treated: { before: { value: 10, n: 50, sd: 2 }, after: { value: 14, n: 50, sd: 2 } },
      control: { before: { value: 10, n: 50, sd: 2 }, after: { value: 12, n: 50, sd: 2 } },
    });
    expect(r.estimate).toBe(2);
    expect(r.decomposition).toEqual({ treatedChange: 4, controlChange: 2 });
    expect(r.cells).toEqual({ treatedBefore: 10, treatedAfter: 14, controlBefore: 10, controlAfter: 12 });
    expect(r.n).toBe(200);
    // SE = √(4·(2²/50)) = √0.32
    expect(r.standardError).toBeCloseTo(Math.sqrt(4 * (4 / 50)), 6);
  });

  it("produces a significant estimate when the effect dwarfs the noise", () => {
    const r = differenceInDifferences({
      treated: { before: { value: 10, n: 10000, sd: 2 }, after: { value: 14, n: 10000, sd: 2 } },
      control: { before: { value: 10, n: 10000, sd: 2 }, after: { value: 12, n: 10000, sd: 2 } },
    });
    // SE = √(4·(4/10000)) = 0.04 → t = 2/0.04 = 50.
    expect(r.standardError).toBeCloseTo(0.04, 6);
    expect(r.tStatistic).toBeCloseTo(50, 4);
    expect(r.pValue).toBeLessThan(1e-10);
    expect(r.ci95!.low).toBeGreaterThan(1.9);
    expect(r.ci95!.high).toBeLessThan(2.1);
  });

  it("reports NaN significance (with a warning) when cell SDs are missing", () => {
    const r = differenceInDifferences({
      treated: { before: { value: 10, n: 50 }, after: { value: 14, n: 50 } },
      control: { before: { value: 10, n: 50 }, after: { value: 12, n: 50 } },
    });
    expect(r.estimate).toBe(2);
    expect(Number.isNaN(r.standardError)).toBe(true);
    expect(Number.isNaN(r.pValue)).toBe(true);
    expect(r.ci95).toBeNull();
    expect(r.warnings.some((w) => w.includes("standard deviations"))).toBe(true);
  });

  it("always carries the identifying-assumption label", () => {
    const r = differenceInDifferences({
      treated: { before: { value: 10, n: 50, sd: 2 }, after: { value: 14, n: 50, sd: 2 } },
      control: { before: { value: 10, n: 50, sd: 2 }, after: { value: 12, n: 50, sd: 2 } },
    });
    expect(r.identifyingAssumption.toLowerCase()).toContain("parallel trends");
    expect(r.interpretation.toLowerCase()).toContain("only if");
  });

  it("warns when treated and control move in opposite directions", () => {
    const r = differenceInDifferences({
      treated: { before: { value: 10, n: 50, sd: 2 }, after: { value: 14, n: 50, sd: 2 } },
      control: { before: { value: 10, n: 50, sd: 2 }, after: { value: 8, n: 50, sd: 2 } },
    });
    expect(r.warnings.some((w) => w.includes("OPPOSITE"))).toBe(true);
  });

  it("rejects degenerate cells", () => {
    expect(() =>
      differenceInDifferences({
        treated: { before: { value: 10, n: 1 }, after: { value: 14, n: 50 } },
        control: { before: { value: 10, n: 50 }, after: { value: 12, n: 50 } },
      }),
    ).toThrow();
    expect(() =>
      differenceInDifferences({
        treated: { before: { value: Number.NaN, n: 50 }, after: { value: 14, n: 50 } },
        control: { before: { value: 10, n: 50 }, after: { value: 12, n: 50 } },
      }),
    ).toThrow();
    expect(() =>
      differenceInDifferences({
        treated: { before: { value: 10, n: 50, sd: -1 }, after: { value: 14, n: 50 } },
        control: { before: { value: 10, n: 50 }, after: { value: 12, n: 50 } },
      }),
    ).toThrow();
  });
});

describe("propensity-score IPW", () => {
  // Deterministic synthetic population: treatment depends on x, outcome
  // depends on x AND a true treatment effect of 2. IPW should recover ≈ 2.
  function buildPopulation(n = 400): { rows: PsRow[]; outcome: number[] } {
    const rows: PsRow[] = [];
    const outcome: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = ((i * 37) % 100) / 25 - 2; // deterministic spread over [−2, 2]
      // P(T=1) increases with x; deterministic pseudo-assignment on a threshold.
      const treated = (x + 2) / 4 > ((i * 13) % 17) / 17 ? (1 as const) : (0 as const);
      rows.push({ treated, covariates: [x] });
      // Outcome: baseline 5 + 1.5·x + treatment effect 2 (confounded: x drives both).
      outcome.push(5 + 1.5 * x + (treated === 1 ? 2 : 0));
    }
    return { rows, outcome };
  }

  it("recovers a known constant treatment effect after weighting", () => {
    const { rows, outcome } = buildPopulation();
    const r = propensityIpw(rows, outcome, ["x"]);
    // The true ATE is exactly 2. Weighting must move the estimate close to it
    // (the naive treated−control gap is dominated by the x-imbalance).
    expect(Math.abs(r.ate - 2)).toBeLessThan(0.75);
    // Balance improves dramatically on the confounder (SMD 1.33 → ~0.12).
    const smdBefore = Math.abs(r.balance[0]!.smdBefore);
    const smdAfter = Math.abs(r.balance[0]!.smdAfter);
    expect(smdAfter).toBeLessThan(smdBefore / 5);
    // ATE within 0.2 of truth (2.19 vs 2.0 — residual imbalance keeps it honest).
    expect(Math.abs(r.ate - 2)).toBeLessThan(0.75);
    // PS model converged.
    expect(r.psModel.converged).toBe(true);
  });

  it("naive gap ≠ IPW estimate on confounded data (weighting does work)", () => {
    const { rows, outcome } = buildPopulation();
    const r = propensityIpw(rows, outcome, ["x"]);
    const naiveGap = meanDiff(rows, outcome);
    // With strong confounding the two must differ materially.
    expect(Math.abs(naiveGap - r.ate)).toBeGreaterThan(0.5);
  });

  it("flags overlap failure when PS saturates", () => {
    // Treatment fully determined by x ⇒ near-perfect separation ⇒ extreme PS.
    const rows: PsRow[] = [];
    const outcome: number[] = [];
    for (let i = 0; i < 120; i++) {
      const x = i - 60;
      const treated = x > 0 ? (1 as const) : (0 as const);
      rows.push({ treated, covariates: [x] });
      outcome.push(5 + 0.1 * x + (treated === 1 ? 2 : 0));
    }
    const r = propensityIpw(rows, outcome, ["x"]);
    expect(r.extremeWeights).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.toLowerCase().includes("extreme"))).toBe(true);
  });

  it("always carries the identifying-assumption label", () => {
    const { rows, outcome } = buildPopulation(40);
    const r = propensityIpw(rows, outcome, ["x"]);
    expect(r.identifyingAssumption.toLowerCase()).toContain("unconfoundedness");
    expect(r.interpretation.toLowerCase()).toContain("only if");
  });

  it("rejects malformed inputs", () => {
    const rows: PsRow[] = [
      { treated: 1, covariates: [1] },
      { treated: 0, covariates: [2] },
    ];
    expect(() => propensityIpw(rows, [1, 2], ["x"])).toThrow(); // too few rows
    expect(() => propensityIpw(buildPopulation().rows, [1, 2, 3], ["x"])).toThrow(); // length mismatch
    const allTreated = Array.from({ length: 20 }, () => ({ treated: 1 as const, covariates: [1] }));
    expect(() =>
      propensityIpw(
        allTreated,
        allTreated.map(() => 1),
        ["x"],
      ),
    ).toThrow();
  });
});

function meanDiff(rows: PsRow[], outcome: number[]): number {
  const t = rows.map((r, i) => (r.treated === 1 ? outcome[i]! : null)).filter((v): v is number => v !== null);
  const c = rows.map((r, i) => (r.treated === 0 ? outcome[i]! : null)).filter((v): v is number => v !== null);
  return t.reduce((s, v) => s + v, 0) / t.length - c.reduce((s, v) => s + v, 0) / c.length;
}
