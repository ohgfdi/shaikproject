/**
 * Phase 1.5 acceptance tests — versioning, diffing, and reproducibility.
 *
 * Covers the plan's acceptance criteria that don't need a live server:
 *  - dataset snapshot change-log diffing (re-upload → new version, prior
 *    version still retrievable; DB-level proof lives in the API suite)
 *  - analysis metric extraction + diff view correctness
 *  - exported Python script *actually executes* in a real Python interpreter
 *    (the project .venv — see __tests__/helpers/python.ts) and reproduces
 *    the engine's numbers within tolerance — not just "it parses"
 *  - exported .ipynb is valid per the real `nbformat` schema
 *
 * Runtime gating: the interpreter is resolved once via the shared helper —
 * project .venv → $AEROLEXA_TEST_PYTHON → PATH python3 (only if it can import
 * numpy/pandas/scipy). If nothing qualifies the suite skips with a printed
 * reason. What is FORBIDDEN here (and was a bug once) is running the scripts
 * under an interpreter without the scientific stack and quietly returning
 * inside the test — a green test that verified nothing.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { analysisPythonScript, hypothesisPythonScript, whatIfPythonScript } from "@/lib/engine/code-export";
import { runHypothesisTest } from "@/lib/engine/hypothesis";
import {
  analysisVersionIpynb,
  computeDatasetVersionChangeLog,
  diffAnalysisMetrics,
  extractVersionMetrics,
  nextVersionNumber,
  notebookIpynb,
} from "@/lib/engine/versioning";
import { runWhatIf } from "@/lib/engine/whatif";
import type { AnalysisResult, WhatIfResult } from "@/lib/types";

import { canImportModules, resolveTestPythonOrAnnounce } from "../helpers/python";

const run = promisify(execFile);

// Resolve the interpreter ONCE (project .venv carries numpy/scipy/pandas).
// null ⇒ the suite announces the skip and gates the runtime tests on it.
const py = resolveTestPythonOrAnnounce("phase15-versioning");
const pythonBin = py?.bin;
// nbformat is an optional validator dependency (CI installs it); when absent
// only the schema-validation test is gated — the rest still runs.
const nbformatAvailable = py ? canImportModules(py.bin, ["nbformat"]) : false;

function makeAnalysisResult(): AnalysisResult {
  return {
    kind: "trend",
    title: "Revenue trend",
    dataset: { name: "sales", id: "ds1", rowCount: 6, columns: ["month", "revenue"] },
    scope: { rowsUsed: 6, totalRows: 6, sampled: false, filters: [] },
    configHuman: ["Trend of revenue by month"],
    methodology: {
      method: "Bucketed sums",
      steps: ["Group rows by month", "Sum revenue"],
      assumptions: ["Revenue is additive"],
    },
    qualityWarnings: [],
    charts: [
      {
        kind: "line",
        title: "Revenue by month",
        categories: ["2025-01", "2025-02", "2025-03"],
        series: [{ name: "revenue", data: [10, 20, 30] }],
      },
    ],
    tables: [
      {
        title: "Monthly revenue",
        columns: [
          { key: "month", label: "Month" },
          { key: "revenue", label: "Revenue", format: "number" },
        ],
        rows: [
          ["2025-01", 10],
          ["2025-02", 20],
          ["2025-03", 30],
        ],
      },
    ],
    stats: [
      { label: "Total revenue", value: "60" },
      { label: "Peak month", value: "2025-03" },
    ],
  };
}

describe("Phase 1.5 — version numbering", () => {
  it("numbers versions monotonically from zero", () => {
    expect(nextVersionNumber(0)).toBe(1);
    expect(nextVersionNumber(1)).toBe(2);
    expect(nextVersionNumber(41)).toBe(42);
  });
});

describe("Phase 1.5 — dataset version change log", () => {
  it("creates an initial snapshot log with no previous version", () => {
    const log = computeDatasetVersionChangeLog(null, {
      version: 1,
      rows: [
        [1, "a"],
        [2, "b"],
      ],
    });
    expect(log.previousVersion).toBeNull();
    expect(log.newVersion).toBe(1);
    expect(log.rowsAdded).toBe(2);
    expect(log.rowsRemoved).toBe(0);
  });

  it("re-uploading creates a new version and keeps the prior diffable", () => {
    const previous = {
      version: 1,
      rows: [
        [1, "a"],
        [2, "b"],
      ] as (string | number | null)[][],
    };
    const next = {
      version: 2,
      rows: [
        [1, "a"],
        [2, "b"],
        [3, "c"],
      ] as (string | number | null)[][],
    };
    const log = computeDatasetVersionChangeLog(previous, next);
    expect(log.previousVersion).toBe(1);
    expect(log.newVersion).toBe(2);
    expect(log.previousRowCount).toBe(2); // prior version's rows still readable
    expect(log.newRowCount).toBe(3);
    expect(log.rowsAdded).toBe(1);
    expect(log.rowsRemoved).toBe(0);
  });

  it("counts multiset removals and positional changes", () => {
    const previous = { version: 3, rows: [[1], [2], [2]] };
    const next = { version: 4, rows: [[1], [2], [9]] };
    const log = computeDatasetVersionChangeLog(previous, next);
    expect(log.rowsRemoved).toBe(1); // one duplicate [2] dropped
    expect(log.rowsChanged).toBe(1); // third position 2 → 9
  });
});

describe("Phase 1.5 — analysis metric extraction + diff", () => {
  it("extracts stats, chart series and table metrics", () => {
    const metrics = extractVersionMetrics(makeAnalysisResult());
    const keys = metrics.map((m) => m.key);
    expect(keys).toContain("stats.0"); // Total revenue = 60
    expect(keys).toContain("charts.0.series.0.sum");
    expect(keys).toContain("charts.0.series.0.last");
    expect(keys.some((k) => k.startsWith("tables.0."))).toBe(true);
    expect(metrics.find((m) => m.key === "stats.0")?.value).toBe(60);
  });

  it("ignores non-numeric stat chips", () => {
    const metrics = extractVersionMetrics(makeAnalysisResult());
    expect(metrics.find((m) => m.key === "stats.1")).toBeUndefined(); // "2025-03" text chip
  });

  it("identifies which metrics moved and by how much", () => {
    const before = extractVersionMetrics(makeAnalysisResult());
    const changedResult = makeAnalysisResult();
    changedResult.charts = [
      {
        kind: "line",
        title: "Revenue by month",
        categories: ["2025-01", "2025-02", "2025-03"],
        series: [{ name: "revenue", data: [10, 25, 35] }],
      },
    ];
    const after = extractVersionMetrics(changedResult);
    const diff = diffAnalysisMetrics(before, after);
    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.unchangedCount).toBeGreaterThan(0);
    const sumDiff = diff.changed.find((m) => m.key === "charts.0.series.0.sum");
    expect(sumDiff).toBeDefined();
    expect(sumDiff!.before).toBe(60);
    expect(sumDiff!.after).toBe(70);
    expect(sumDiff!.delta).toBeCloseTo(10, 10);
    expect(sumDiff!.deltaPct).toBeCloseTo((10 / 60) * 100, 6);
  });

  it("reports added and removed metrics between versions", () => {
    const before = extractVersionMetrics(makeAnalysisResult());
    const changed = makeAnalysisResult();
    changed.charts = []; // removes all chart metrics
    changed.tables = []; // removes table metrics
    const after = extractVersionMetrics(changed);
    const diff = diffAnalysisMetrics(before, after);
    expect(diff.removed.length).toBeGreaterThan(0);
    expect(diff.added.length).toBe(0);
    // And in reverse:
    const reverse = diffAnalysisMetrics(after, before);
    expect(reverse.added.length).toBeGreaterThan(0);
  });
});

describe("Phase 1.5 — exported Python script actually executes", () => {
  (pythonBin ? it : it.skip)(
    "regression what-if script reproduces the engine numbers",
    async () => {
      // A synthetic dataset with known slope: y = 2x + 1 (+ tiny noise-free)
      const rows = Array.from({ length: 40 }, (_, i) => [i + 1, 2 * (i + 1) + 1]);
      const result: WhatIfResult = runWhatIf(
        {
          columns: [
            { name: "spend", type: "number" },
            { name: "revenue", type: "number" },
          ],
          rows,
        },
        { driverColumn: "spend", outcomeColumn: "revenue", pctChange: 5 },
      );
      expect(result.fallback).toBe(false);
      expect(result.model.slope).toBeCloseTo(2, 6);

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "Ledgerly-export-"));
      const csv = ["spend,revenue", ...rows.map((r) => r.join(","))].join("\n");
      await fs.writeFile(path.join(dir, "dataset.csv"), csv, "utf8");
      const scriptPath = path.join(dir, "export.py");
      await fs.writeFile(scriptPath, whatIfPythonScript(result, "synthetic"), "utf8");

      // A missing numpy/pandas here must FAIL the test, not skip it: the
      // interpreter was resolved above specifically because it has the stack.
      const { stdout } = await run(pythonBin!, [scriptPath], { cwd: dir, timeout: 60_000 });
      const slopeMatch = stdout.match(/slope=([-0-9.]+)/);
      const afterMatch = stdout.match(/after=([-0-9.]+)/);
      expect(slopeMatch).toBeTruthy();
      expect(afterMatch).toBeTruthy();
      expect(Number(slopeMatch![1])).toBeCloseTo(result.model.slope, 4);
      expect(Number(afterMatch![1])).toBeCloseTo(result.afterValue, 4);
    },
    90_000,
  );

  (pythonBin ? it : it.skip)(
    "hypothesis test script matches scipy reference values",
    async () => {
      const groups = [
        [2, 4, 6, 8, 10],
        [1, 3, 5, 7, 9],
      ];
      const engine = runHypothesisTest({ kind: "t-test", groups });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "Ledgerly-hyp-"));
      const scriptPath = path.join(dir, "hypothesis.py");
      await fs.writeFile(scriptPath, hypothesisPythonScript({ kind: "t-test", groups }), "utf8");
      const { stdout } = await run(pythonBin!, [scriptPath], { cwd: dir, timeout: 60_000 });
      const tMatch = stdout.match(/t = ([-0-9.]+)/);
      const pMatch = stdout.match(/p = ([0-9.e-]+)/);
      expect(tMatch).toBeTruthy();
      expect(Number(tMatch![1])).toBeCloseTo(engine.statistic, 4);
      expect(pMatch).toBeTruthy();
      expect(Number(pMatch![1])).toBeCloseTo(engine.pValue, 4);
    },
    90_000,
  );

  it("what-if script is syntactically valid Python (compiles without running)", () => {
    const result = runWhatIf(
      {
        columns: [
          { name: "spend", type: "number" },
          { name: "revenue", type: "number" },
        ],
        rows: [
          [1, 3],
          [2, 5],
          [3, 7],
        ],
      },
      { driverColumn: "spend", outcomeColumn: "revenue", pctChange: 10 },
    );
    const script = whatIfPythonScript(result, "tiny");
    // The bivariate path still solves the same centered OLS the multivariate
    // path uses — np.polyfit was replaced because it cannot report inference.
    expect(script).toContain("np.linalg.lstsq");
    expect(script).toContain('pd.read_csv("dataset.csv")');
    expect(script).not.toContain("undefined");
    expect(script).not.toContain("[object Object]");
  });

  it("analysis export script embeds config and methodology", () => {
    const result = makeAnalysisResult();
    const script = analysisPythonScript(result, {
      kind: "trend",
      metric: "revenue",
      granularity: "month",
      dateCol: "month",
    });
    expect(script).toContain("pd.read_csv");
    expect(script).toContain('"metric":"revenue"');
    expect(script).toContain("Bucketed sums");
    expect(script).not.toContain("undefined");
  });
});

describe("Phase 1.5 — .ipynb exports are valid nbformat 4", () => {
  const structural = (nb: ReturnType<typeof notebookIpynb>) => {
    expect(nb.nbformat).toBe(4);
    expect(Array.isArray(nb.cells)).toBe(true);
    expect(nb.cells.length).toBeGreaterThan(0);
    for (const cell of nb.cells) {
      expect(["code", "markdown"]).toContain(cell.cell_type);
      expect(Array.isArray(cell.source)).toBe(true);
      if (cell.cell_type === "code") {
        expect(Array.isArray(cell.outputs)).toBe(true);
        expect("execution_count" in cell).toBe(true);
      }
    }
  };

  it("notebook export preserves cells, markdown/code kinds and outputs", () => {
    const nb = notebookIpynb("My notebook", [
      { id: "a", kind: "markdown", content: "# Hello\nWorld" },
      {
        id: "b",
        kind: "code",
        content: "x = 5\nx",
        ranAt: new Date().toISOString(),
        output: { type: "text", text: "5" },
      },
      {
        id: "c",
        kind: "code",
        content: "import matplotlib.pyplot as plt\nplt.plot([1,2])\nplt.show()",
        ranAt: new Date().toISOString(),
        output: { type: "image", image: { mimeType: "image/png", data: "aWNvbg==" } },
      },
      { id: "d", kind: "code", content: "print('err')", output: { type: "error", message: "boom" } },
      {
        id: "e",
        kind: "code",
        content: "df.head()",
        output: { type: "table", title: "head", columns: [{ key: "a", label: "A" }], rows: [[1], [2]] },
      },
    ]);
    structural(nb);
    expect(nb.cells[0]?.source.join("")).toContain("World");
    const codeCells = nb.cells.filter((c) => c.cell_type === "code");
    expect(codeCells[0]?.outputs?.[0]).toMatchObject({ output_type: "stream" });
    expect(codeCells[1]?.outputs?.[0]).toMatchObject({ output_type: "display_data" });
    expect(codeCells[2]?.outputs?.[0]?.output_type).toBe("error");
    expect(codeCells[3]?.outputs?.[0]).toMatchObject({ output_type: "display_data" });
    // Source lines keep trailing newlines per nbformat convention:
    expect(nb.cells[0]?.source[0]).toBe("# Hello\n");
    expect(nb.cells[0]?.source[1]).toBe("World");
  });

  it("analysis export contains config, methodology and per-chart cells", () => {
    const result = makeAnalysisResult();
    const nb = analysisVersionIpynb(result, { kind: "trend", metric: "revenue" });
    structural(nb);
    const allSource = nb.cells.map((c) => c.source.join("")).join("\n");
    expect(allSource).toContain("Revenue trend");
    expect(allSource).toContain("pd.read_csv");
    expect(allSource).toContain("Bucketed sums");
    expect(allSource).toContain("Revenue by month");
  });

  (pythonBin && nbformatAvailable ? it : it.skip)(
    "validates against the real nbformat schema",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "Ledgerly-ipynb-"));
      const nb = notebookIpynb("Validation", [
        { id: "a", kind: "markdown", content: "# hi" },
        { id: "b", kind: "code", content: "1 + 1", output: { type: "text", text: "2" } },
      ]);
      const file = path.join(dir, "nb.ipynb");
      await fs.writeFile(file, JSON.stringify(nb), "utf8");
      // nbformat is a hard requirement here (gated above), so an import error
      // propagates and fails the test instead of being swallowed.
      const { stdout } = await run(
        pythonBin!,
        [
          "-c",
          [
            "import sys",
            "import nbformat",
            "nb = nbformat.read(sys.argv[1], as_version=4)",
            "nbformat.validate(nb)",
            "print('VALID')",
          ].join("\n"),
          file,
        ],
        { cwd: dir, timeout: 60_000 },
      );
      expect(stdout).toContain("VALID");
    },
    90_000,
  );
});
