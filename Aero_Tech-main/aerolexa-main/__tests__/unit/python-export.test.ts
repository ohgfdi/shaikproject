/**
 * Phase 1.5 "Export runnable code" acceptance tests.
 *
 * The Phase 1.5 spec requires the exported Python script to be ACTUALLY
 * EXECUTED in a clean Python environment and reproduce the same numeric
 * result the app displayed (within floating point tolerance) — not just to
 * parse or contain the right calls. These tests run every exported script
 * through the project-local .venv (numpy/scipy/pandas/scikit-learn) and
 * compare the printed RESULT line against the engine's own output.
 *
 * Also validates exported .ipynb documents against the real `nbformat`
 * library (JSON schema + structure validation).
 *
 * The interpreter is resolved through the shared helper (see
 * __tests__/helpers/python.ts): project .venv → $AEROLEXA_TEST_PYTHON → PATH
 * python3, probed for numpy/pandas/scipy. When nothing qualifies the suite
 * skips with a printed reason — a visible, announced skip, never a silent
 * downgrade inside a passing test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAnalysis } from "@/lib/engine/analyses";
import { runHypothesisTest } from "@/lib/engine/hypothesis";
import { trainModel } from "@/lib/engine/training";
import { runWhatIf } from "@/lib/engine/whatif";
import {
  exportAnalysisScript,
  exportHypothesisScript,
  exportModelScript,
  exportNotebookToIpynb,
  exportWhatIfScript,
} from "@/lib/export/python";
import type { ColumnDef, NotebookCell } from "@/lib/types";

import { resolveTestPythonOrAnnounce } from "../helpers/python";

// Resolved once at module load; null ⇒ the whole suite skips, announced.
const py = resolveTestPythonOrAnnounce("python-export");
const PY = py?.bin ?? "python3";
const maybe = py ? describe : describe.skip;

/** Write a script to a temp file and execute it with the .venv interpreter. */
function runScript(script: string): Record<string, unknown> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "Ledgerly-export-"));
  const file = path.join(dir, "export.py");
  writeFileSync(file, script);
  const out = spawnSync(PY, [file], { encoding: "utf8", timeout: 120_000 });
  const stdout = out.stdout ?? "";
  const stderr = out.stderr ?? "";
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT: "));
  if (out.status !== 0 || !line) {
    throw new Error(`exported script failed (status ${out.status}):\n${stdout}\n${stderr}`);
  }
  return JSON.parse(line.slice("RESULT: ".length)) as Record<string, unknown>;
}

/** Execute a python snippet with a file argument (used for .ipynb validation). */
function runPython(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(PY, args, { encoding: "utf8", input, timeout: 60_000 });
  return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

maybe("executed Python exports reproduce the app's numbers", () => {
  it("what-if: exported OLS script matches the engine result exactly", () => {
    const columns: ColumnDef[] = [
      { name: "price", type: "number" },
      { name: "margin", type: "number" },
    ];
    // Strong linear relationship (plus tiny deterministic noise) so the OLS
    // path is used, not the r² < 0.12 hypothetical fallback.
    const rows: (number | null)[][] = Array.from({ length: 48 }, (_, i) => {
      const price = 10 + i * 2;
      const margin = 5 + 2 * price + (i % 2);
      return [price, margin];
    });

    const result = runWhatIf({ columns, rows }, { driverColumn: "price", outcomeColumn: "margin", pctChange: 10 });
    expect(result.fallback).toBe(false);

    const script = exportWhatIfScript(result, "price-margin.csv", columns, rows);
    const py = runScript(script);

    expect(py.beforeValue).toBeCloseTo(result.beforeValue, 4);
    expect(py.afterValue).toBeCloseTo(result.afterValue, 4);
    expect(py.delta).toBeCloseTo(result.delta, 4);
    expect(py.driverMean).toBeCloseTo(result.driverMean, 4);
    expect(py.slope).toBeCloseTo(result.model.slope, 4);
    expect(py.intercept).toBeCloseTo(result.model.intercept, 4);
    expect(py.rSquared).toBeCloseTo(result.model.rSquared, 4);
    expect(py.pValue).toBeCloseTo(result.model.pValue, 4);
    expect(py.points).toBe(result.model.points);
    expect(py.fallback).toBe(false);
  });

  it("model: exported linear-regression script reproduces test metrics + weights", () => {
    const columns: ColumnDef[] = [
      { name: "x1", type: "number" },
      { name: "x2", type: "number" },
      { name: "y", type: "number" },
    ];
    const rows: (number | null)[][] = Array.from({ length: 60 }, (_, i) => {
      const x1 = i * 0.5;
      const x2 = 2 + (i % 7);
      return [x1, x2, 3 * x1 + 2 * x2 + (i % 3) * 0.5];
    });

    const card = trainModel(
      { columns, rows },
      {
        task: "regression",
        targetColumn: "y",
        algorithm: "linear-regression",
        testRatio: 0.2,
        cvFolds: 0,
        name: "reg-test",
      },
    );

    const script = exportModelScript(card, columns, rows);
    const py = runScript(script);

    expect(py.testR2).toBeCloseTo(card.metrics.testR2 ?? 0, 4);
    expect(py.testRmse).toBeCloseTo(card.metrics.testRmse ?? 0, 4);
    expect(py.testMae).toBeCloseTo(card.metrics.testMae ?? 0, 4);
    // Weights are the standardized-feature coefficients the app stored.
    expect((py.weights as number[])[0]).toBeCloseTo(card.weights[0] ?? 0, 4);
    expect((py.weights as number[])[1]).toBeCloseTo(card.weights[1] ?? 0, 4);
  });

  it("hypothesis: exported scipy t-test matches the engine's statistic and p-value", () => {
    const input = {
      kind: "t-test" as const,
      groups: [
        [2, 4, 6, 8, 10],
        [1, 3, 5, 7, 9],
      ],
    };
    const result = runHypothesisTest(input);
    const script = exportHypothesisScript(
      input,
      `In-app t-test: t=${result.statistic.toFixed(6)}, p=${result.pValue.toFixed(3)}, df=${result.degreesOfFreedom}`,
    );
    const py = runScript(script);

    expect(py.statistic).toBeCloseTo(result.statistic, 6);
    expect(py.pValue).toBeCloseTo(result.pValue, 3);
    expect(py.degreesOfFreedom).toBe(result.degreesOfFreedom);
  });

  it("analysis: exported KPI script recomputes the same sum the app displayed", () => {
    const columns: ColumnDef[] = [
      { name: "region", type: "string" },
      { name: "revenue", type: "number" },
    ];
    const rows: (string | number | null)[][] = [
      ["East", 1200],
      ["East", 980],
      ["West", 1350],
      ["West", 760],
      ["East", 1500],
      ["West", 1620],
    ];

    const result = runAnalysis(
      { datasetId: "kpi-ds", datasetName: "revenue", totalRows: rows.length, columns, rows },
      { kind: "kpi", metric: "revenue", granularity: "month" },
    );

    const script = exportAnalysisScript(
      result,
      { kind: "kpi", metric: "revenue", granularity: "month" },
      columns,
      rows,
    );
    const py = runScript(script);

    // The app displays the KPI "Sum" stat (fmtShort: integers ≥ 100 are exact).
    const sumStat = result.stats?.find((s) => s.label === "Sum");
    expect(sumStat).toBeDefined();
    const displayedSum = Number(String(sumStat!.value).replace(/[,$]/g, ""));
    expect(py.sum).toBeCloseTo(displayedSum, 6);
    // Mean: 1200+980+1350+760+1500+1620 = 7410 → mean 1235 (exact).
    expect(py.mean).toBeCloseTo(1235, 6);
    expect(py.count).toBe(6);
  });
});

maybe("exported .ipynb documents are valid Jupyter notebooks", () => {
  it("passes nbformat validation with cells + outputs preserved", () => {
    const cells: NotebookCell[] = [
      { id: "m1", kind: "markdown", content: "# Revenue notes\n\nQ1 recap", output: null, ranAt: null },
      {
        id: "c1",
        kind: "code",
        content: "x = 5\nprint(x)",
        output: { type: "text", text: "5" },
        ranAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c2",
        kind: "code",
        content: "df.describe()",
        output: {
          type: "table",
          title: "Summary",
          columns: [
            { key: "col", label: "Column" },
            { key: "mean", label: "Mean" },
          ],
          rows: [
            ["revenue", 1235],
            ["margin", 42.5],
          ] as (string | number | null)[][],
        },
        ranAt: null,
      },
      {
        id: "c3",
        kind: "code",
        content: "plt.plot(df)",
        output: {
          type: "image",
          image: {
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        },
        ranAt: null,
      },
      {
        id: "c4",
        kind: "code",
        content: "raise ValueError('boom')",
        output: { type: "error", message: "boom" },
        ranAt: null,
      },
    ];

    const doc = exportNotebookToIpynb(cells, "Revenue Analysis");
    expect(doc.nbformat).toBe(4);
    expect((doc.cells as Record<string, unknown>[]).length).toBe(5);

    const dir = mkdtempSync(path.join(os.tmpdir(), "Ledgerly-ipynb-"));
    const file = path.join(dir, "notebook.ipynb");
    writeFileSync(file, JSON.stringify(doc));

    // Real nbformat validation: structure + JSON schema checks.
    const out = runPython(
      [
        "-c",
        "import nbformat, sys; nb = nbformat.read(sys.argv[1], as_version=4); nbformat.validate(nb); print('VALID')",
        file,
      ],
      undefined,
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("VALID");

    // Cells and outputs preserved round-trip.
    const parsed = runPython(
      [
        "-c",
        "import nbformat, json, sys; nb = nbformat.read(sys.argv[1], as_version=4); print(json.dumps([(c.cell_type, len(c.get('outputs', [])) if c.cell_type == 'code' else None) for c in nb.cells]))",
        file,
      ],
      undefined,
    );
    expect(parsed.status).toBe(0);
    const kinds = JSON.parse(parsed.stdout) as [string, number | null][];
    expect(kinds.map((k) => k[0])).toEqual(["markdown", "code", "code", "code", "code"]);
    expect(kinds.filter((k) => k[0] === "code").map((k) => k[1])).toEqual([1, 1, 1, 1]);
  });
});
