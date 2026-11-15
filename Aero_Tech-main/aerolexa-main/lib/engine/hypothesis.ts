export type HypothesisInput =
  | { kind: "t-test"; groups: number[][] }
  | { kind: "chi-square"; table: number[][] }
  | { kind: "anova"; groups: number[][] };

export interface HypothesisAssumption {
  name: string;
  passed: boolean;
  warning?: string;
}

export interface HypothesisResult {
  kind: HypothesisInput["kind"];
  statistic: number;
  pValue: number;
  degreesOfFreedom: number | [number, number];
  assumptions: HypothesisAssumption[];
  interpretation: string;
}

export class HypothesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HypothesisError";
  }
}

export function runHypothesisTest(input: HypothesisInput): HypothesisResult {
  if (!input || typeof input !== "object" || !("kind" in input)) {
    throw new HypothesisError("Choose a hypothesis test and provide its input data.");
  }
  if (input.kind === "t-test") return twoSampleTTest(input.groups);
  if (input.kind === "chi-square") return chiSquareTest(input.table);
  if (input.kind === "anova") return oneWayAnova(input.groups);
  throw new HypothesisError("Test kind must be t-test, chi-square, or anova.");
}

function twoSampleTTest(groups: number[][]): HypothesisResult {
  if (groups.length !== 2) throw new HypothesisError("A two-sample t-test needs exactly two groups.");
  const first = cleanGroup(groups[0] ?? []);
  const second = cleanGroup(groups[1] ?? []);
  if (first.length < 2 || second.length < 2)
    throw new HypothesisError("Each t-test group needs at least two finite values.");
  const varianceFirst = variance(first);
  const varianceSecond = variance(second);
  const pooled =
    ((first.length - 1) * varianceFirst + (second.length - 1) * varianceSecond) / (first.length + second.length - 2);
  if (pooled <= 0) throw new HypothesisError("The t-test groups must contain variation.");
  const statistic = (mean(first) - mean(second)) / Math.sqrt(pooled * (1 / first.length + 1 / second.length));
  const degreesOfFreedom = first.length + second.length - 2;
  const pValue = clamp(2 * studentTUpperTail(Math.abs(statistic), degreesOfFreedom));
  const varianceRatio =
    Math.max(varianceFirst, varianceSecond) / Math.max(1e-12, Math.min(varianceFirst, varianceSecond));
  const passed = varianceRatio <= 4;
  return {
    kind: "t-test",
    statistic,
    pValue,
    degreesOfFreedom,
    assumptions: [
      {
        name: "variance homogeneity",
        passed,
        ...(passed
          ? {}
          : { warning: "Group variances differ by more than 4x; interpret the pooled t-test cautiously." }),
      },
    ],
    interpretation:
      pValue < 0.05
        ? "The group means differ statistically at the 5% level."
        : "The observed difference in group means is not statistically significant at the 5% level.",
  };
}

function chiSquareTest(table: number[][]): HypothesisResult {
  if (table.length < 2 || table.some((row) => row.length !== table[0]?.length || row.length < 2)) {
    throw new HypothesisError("A chi-square test needs a rectangular table with at least two rows and columns.");
  }
  if (table.some((row) => row.some((value) => !Number.isFinite(value) || value < 0)))
    throw new HypothesisError("Chi-square counts must be finite non-negative numbers.");
  const columns = table[0]!.length;
  const rowTotals = table.map((row) => row.reduce((sum, value) => sum + value, 0));
  const columnTotals = Array.from({ length: columns }, (_, column) =>
    table.reduce((sum, row) => sum + row[column]!, 0),
  );
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new HypothesisError("The chi-square table must contain at least one count.");
  let statistic = 0;
  let expectedBelowFive = false;
  for (let row = 0; row < table.length; row++) {
    for (let column = 0; column < columns; column++) {
      const expected = (rowTotals[row]! * columnTotals[column]!) / total;
      if (expected < 5) expectedBelowFive = true;
      if (expected > 0) statistic += (table[row]![column]! - expected) ** 2 / expected;
    }
  }
  const degreesOfFreedom = (table.length - 1) * (columns - 1);
  const pValue = clamp(regularizedGammaQ(degreesOfFreedom / 2, statistic / 2));
  return {
    kind: "chi-square",
    statistic,
    pValue,
    degreesOfFreedom,
    assumptions: [
      {
        name: "expected cell counts",
        passed: !expectedBelowFive,
        ...(!expectedBelowFive
          ? {}
          : { warning: "At least one expected count is below 5; chi-square approximation may be unreliable." }),
      },
    ],
    interpretation:
      pValue < 0.05
        ? "The categorical variables show evidence of association."
        : "The categorical variables show no statistically significant association at the 5% level.",
  };
}

function oneWayAnova(groups: number[][]): HypothesisResult {
  if (groups.length < 2) throw new HypothesisError("ANOVA needs at least two groups.");
  const clean = groups.map(cleanGroup);
  if (clean.some((group) => group.length < 2))
    throw new HypothesisError("Each ANOVA group needs at least two finite values.");
  const all = clean.flat();
  const grandMean = mean(all);
  const between = clean.reduce((sum, group) => sum + group.length * (mean(group) - grandMean) ** 2, 0);
  const within = clean.reduce((sum, group) => sum + (group.length - 1) * variance(group), 0);
  const dfBetween = clean.length - 1;
  const dfWithin = all.length - clean.length;
  if (within <= 0) throw new HypothesisError("ANOVA requires within-group variation.");
  const statistic = between / dfBetween / (within / dfWithin);
  const pValue = clamp(regularizedBeta(dfWithin / (dfWithin + dfBetween * statistic), dfWithin / 2, dfBetween / 2));
  const variances = clean.map(variance);
  const varianceRatio = Math.max(...variances) / Math.max(1e-12, Math.min(...variances));
  const passed = varianceRatio <= 4;
  return {
    kind: "anova",
    statistic,
    pValue,
    degreesOfFreedom: [dfBetween, dfWithin],
    assumptions: [
      {
        name: "variance homogeneity",
        passed,
        ...(passed
          ? {}
          : { warning: "Group variances differ by more than 4x; ANOVA results should be interpreted cautiously." }),
      },
    ],
    interpretation:
      pValue < 0.05
        ? "At least one group mean differs statistically at the 5% level."
        : "The group means do not differ statistically at the 5% level.",
  };
}

function cleanGroup(values: number[]): number[] {
  if (!Array.isArray(values)) throw new HypothesisError("Test groups must be arrays.");
  const clean = values.filter(Number.isFinite);
  if (clean.length !== values.length)
    throw new HypothesisError("Test data contains invalid or missing numeric values.");
  return clean;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function studentTUpperTail(value: number, degreesOfFreedom: number): number {
  return 0.5 * regularizedBeta(degreesOfFreedom / (degreesOfFreedom + value * value), degreesOfFreedom / 2, 0.5);
}

/** Exported for reuse by the A/B test engine (Beta posterior integration). */
export function regularizedBeta(x: number, a: number, b: number): number {
  return regularizedBetaImpl(x, a, b);
}

/** Exported for reuse by the A/B test engine (Beta log-density). */
export function logGamma(value: number): number {
  return logGammaImpl(value);
}

/** Exact upper tail of the χ² distribution — Q(df/2, x/2). Exported for the
 * elite-stats engine (Kruskal–Wallis, log-rank) so there is ONE gamma
 * implementation in the repo. */
export function regularizedGammaQ(shape: number, value: number): number {
  if (value <= 0) return 1;
  if (value < shape + 1) return 1 - regularizedGammaPSeries(shape, value);
  let b = value + 1 - shape;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-7) break;
  }
  return Math.exp(-value + shape * Math.log(value) - logGamma(shape)) * h;
}

function regularizedGammaPSeries(shape: number, value: number): number {
  let sum = 1 / shape;
  let term = sum;
  for (let i = 1; i <= 200; i++) {
    term *= value / (shape + i);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 3e-7) break;
  }
  return sum * Math.exp(-value + shape * Math.log(value) - logGamma(shape));
}

/** Internal implementation — wrapped for export below. */
function regularizedBetaImpl(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (factor * betaFractionImpl(x, a, b)) / a;
  return 1 - (factor * betaFractionImpl(1 - x, b, a)) / b;
}

function betaFractionImpl(x: number, a: number, b: number): number {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    numerator = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-7) break;
  }
  return h;
}

function logGammaImpl(value: number): number {
  const coefficients = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const shifted = value - 1;
  let sum = coefficients[0]!;
  for (let i = 1; i < coefficients.length; i++) sum += coefficients[i]! / (shifted + i);
  const t = shifted + coefficients.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}
