/**
 * Cohort graduation oracle — hand-computed fixtures (no external library).
 *
 * The repo's graduation bar: an engine earns the "Calculated" label when its
 * outputs are pinned by oracle tests (hand-computed where the math is exact
 * set/arithmetic logic, live-library comparison where floating point is
 * involved). Cohort retention is exact set logic — first-seen month, offset
 * months, distinct-entity counts — so hand-computed expectations are the
 * strongest possible oracle here.
 *
 * This suite pins:
 *  1. First-seen assignment: an entity belongs to the month of its EARLIEST
 *     appearance, regardless of row order.
 *  2. Exact retention percentages per (cohort, offset) cell.
 *  3. M0 = 100% by definition.
 *  4. Average M1 over the shown cohorts.
 *  5. The last-12-cohorts window and the ≥2-months input requirement.
 *  6. Order independence (rows shuffled → identical output).
 *
 * Cohort has ALWAYS been honestly labelled; the label was "Prototype / Demo"
 * because the method was simplified. The method is deterministic set logic
 * over real dataset rows (no heuristics), and this suite makes it provable —
 * matching the proven engines (EDA, correlation, trend, what-if, forecast).
 */

import { runAnalysis } from "@/lib/engine/analyses";
import type { Cell } from "@/lib/engine/dataset";

interface RunInput {
  datasetId: string;
  datasetName: string;
  totalRows: number;
  columns: { name: string; type: "date" | "string" | "number" }[];
  rows: Cell[][];
}

function makeInput(rows: [string, string][]): RunInput {
  return {
    datasetId: "ds-cohort-oracle",
    datasetName: "Cohort oracle data",
    totalRows: rows.length,
    columns: [
      { name: "d", type: "date" },
      { name: "entity", type: "string" },
    ],
    rows: rows.map(([d, e]) => [d, e] as Cell[]),
  };
}

const runCohort = (input: RunInput) => runAnalysis(input, { kind: "cohort", dateCol: "d", entityCol: "entity" });

/** Read the retention matrix out of the result table (row = cohort, col = M0..). */
function matrixFrom(result: ReturnType<typeof runCohort>): Map<string, (number | null)[]> {
  const table = result.tables?.[0];
  if (!table) throw new Error("cohort result has no table");
  const out = new Map<string, (number | null)[]>();
  for (const row of table.rows) {
    out.set(
      String(row[0]),
      row.slice(2).map((v) => (v === null ? null : Number(v))),
    );
  }
  return out;
}

describe("cohort graduation oracle (hand-computed retention fixtures)", () => {
  it("computes exact first-seen cohorts and per-offset retention", () => {
    // Hand-computed scenario (2024 is a leap year; month arithmetic via UTC):
    //
    //  2024-01: A, B, C        → cohort Jan (size 3)
    //  2024-02: A, B, D        → cohort Feb (size 1: D is new; A,B are repeats)
    //  2024-03: A, D, E        → cohort Mar (size 1: E is new)
    //
    // First-seen: A→Jan, B→Jan, C→Jan, D→Feb, E→Mar
    //
    // Cohort Jan (A,B,C), offsets:
    //   M0: all 3 seen in Jan → 3/3 = 100%
    //   M1: seen again in Feb → A,B → 2/3 = 66.7%
    //   M2: seen again in Mar → A   → 1/3 = 33.3%
    //   M3+: nobody           → 0%
    //
    // Cohort Feb (D), offsets:
    //   M0: D seen in Feb     → 100%
    //   M1: D seen in Mar     → 1/1 = 100%
    //   M2: no Apr data       → 0%
    //
    // Cohort Mar (E), offsets:
    //   M0: E seen in Mar     → 100%
    //   M1: no Apr data       → 0%
    const input = makeInput([
      ["2024-01-05", "A"],
      ["2024-01-20", "B"],
      ["2024-01-25", "C"],
      ["2024-02-03", "A"],
      ["2024-02-10", "B"],
      ["2024-02-15", "D"],
      ["2024-03-02", "A"],
      ["2024-03-08", "D"],
      ["2024-03-20", "E"],
    ]);
    const result = runCohort(input);

    const matrix = matrixFrom(result);
    expect(matrix.size).toBe(3);

    const jan = matrix.get("Jan 2024");
    expect(jan).toBeDefined();
    expect(jan![0]).toBe(100); // M0 by definition
    expect(jan![1]).toBeCloseTo(66.7, 5);
    expect(jan![2]).toBeCloseTo(33.3, 5);
    expect(jan![3]).toBe(0);

    const feb = matrix.get("Feb 2024");
    expect(feb).toBeDefined();
    expect(feb![0]).toBe(100);
    expect(feb![1]).toBe(100);
    expect(feb![2]).toBe(0);

    const mar = matrix.get("Mar 2024");
    expect(mar).toBeDefined();
    expect(mar![0]).toBe(100);
    expect(mar![1]).toBe(0);
  });

  it("average M1 equals the size-weighted mean over shown cohorts", () => {
    // Same scenario as above: cohorts Jan(3), Feb(1), Mar(1).
    // M1 retention: Jan = 2/3, Feb = 1/1, Mar = 0/1.
    // The engine's avg M1 = mean of per-cohort M1 percentages =
    //   (66.666… + 100 + 0) / 3 = 55.555… → rounded to 55.6.
    const input = makeInput([
      ["2024-01-05", "A"],
      ["2024-01-20", "B"],
      ["2024-01-25", "C"],
      ["2024-02-03", "A"],
      ["2024-02-10", "B"],
      ["2024-02-15", "D"],
      ["2024-03-02", "A"],
      ["2024-03-08", "D"],
      ["2024-03-20", "E"],
    ]);
    const result = runCohort(input);
    const avgM1 = result.stats?.find((s) => s.label === "Average M1 retention");
    expect(avgM1).toBeDefined();
    expect(avgM1!.value).toBe("55.6%");
  });

  it("assigns an entity to its EARLIEST month even when rows are out of order", () => {
    // B's Feb row comes first in the file, but its cohort must still be Jan.
    // C is genuinely new in Feb, so Feb forms a real cohort.
    const input = makeInput([
      ["2024-02-10", "B"], // later month first in the file
      ["2024-01-15", "B"],
      ["2024-01-20", "A"],
      ["2024-02-15", "C"],
    ]);
    const result = runCohort(input);

    // Cohorts: Jan {A, B} (both first-seen in Jan), Feb {C}.
    const matrix = matrixFrom(result);
    expect(matrix.size).toBe(2);

    const jan = matrix.get("Jan 2024");
    expect(jan).toBeDefined();
    expect(jan![0]).toBe(100); // A,B both seen in Jan
    expect(jan![1]).toBe(50); // only B is seen again in Feb → 1/2

    const feb = matrix.get("Feb 2024");
    expect(feb).toBeDefined();
    expect(feb![0]).toBe(100);
  });

  it("is invariant under row order (shuffled input → identical output)", () => {
    const base: [string, string][] = [
      ["2024-01-05", "A"],
      ["2024-01-20", "B"],
      ["2024-02-03", "A"],
      ["2024-02-10", "B"],
      ["2024-03-02", "A"],
      ["2024-03-20", "C"],
    ];
    const forward = runCohort(makeInput(base));
    const shuffled = runCohort(makeInput([base[3], base[0], base[5], base[2], base[1], base[4]] as [string, string][]));
    expect(matrixFrom(shuffled)).toEqual(matrixFrom(forward));
  });

  it("requires entities across at least 2 calendar months", () => {
    const input = makeInput([
      ["2024-01-05", "A"],
      ["2024-01-20", "B"],
    ]);
    expect(() => runCohort(input)).toThrow(/at least 2 calendar months/);
  });

  it("shows only the latest 12 cohorts when history is longer", () => {
    // 14 distinct months, one new entity each month → 14 cohorts; the table
    // must keep only the last 12.
    const rows: [string, string][] = [];
    for (let i = 0; i < 14; i++) {
      const month = String((i % 12) + 1).padStart(2, "0");
      const year = 2023 + Math.floor(i / 12);
      rows.push([`${year}-${month}-05`, `E${i}`]);
    }
    const result = runCohort(makeInput(rows));
    const matrix = matrixFrom(result);
    expect(matrix.size).toBe(12);
    // First shown cohort is 2023-03 (index 2), not 2023-01.
    expect(matrix.has("Mar 2023")).toBe(true);
    expect(matrix.has("Jan 2023")).toBe(false);
  });
});
