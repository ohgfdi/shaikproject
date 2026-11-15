# Missing @/lib/export/python module — Phase 1.5 verification

## Issue

The `@/lib/export/python` module was referenced during Tier 1.5 TypeScript check as "missing" — the "export runnable code" feature from Tier 1.5 was referenced but the module's existence and completeness was unconfirmed at verification time. The module at `lib/export/python.ts` exists with export functions, but it has not been verified as fully functional through end-to-end execution.

## What exists

`lib/export/python.ts` contains the following exported functions:

- `exportAnalysisScript(result, cfg, columns, rows)` — Generates Python scripts for KPI, trend, correlation, distribution, segmentation, or generic summary analyses
- `exportWhatIfScript(result, datasetName, columns, rows)` — Generates Python scripts for ordinary least squares what-if projections
- `exportModelScript(card, columns, rows)` — Generates Python scripts for model cards (linear/regression/logistic/random-forest/gradient-boosting/clustering)
- `exportHypothesisScript(input, resultNotes)` — Generates Python scripts for hypothesis tests (t-test, chi-square, ANOVA using scipy)
- `exportNotebookToIpynb(cells, title)` — Converts notebook cells to `nbformat v4` JSON documents

The test suite at `__tests__/unit/python-export.test.ts` imports from this module and attempts to execute exported scripts through a local `.venv` environment (requiring `python` at `.venv/bin/python`), comparing `RESULT:` output against the app's own computations.

## Current verification status

⚠️ **UNCONFIRMED** — The module exists and functions are implemented, but the following issues need verification:

1. **TypeScript import errors** in the test file:
   - `__tests__/unit/python-export.test.ts(76,7)`: `Argument of type '{ driverColumn: string; outcomeColumn: string; pctChange: number; }' is not assignable to parameter of type 'WhatIfResult'`
   - `__tests__/unit/python-export.test.ts(139,50)`: `Argument of type 'HypothesisResult' is not assignable to parameter of type 'string'`
   - `__tests__/unit/python-export.test.ts(213,39)`: `Argument of type 'NotebookCell[]' is not assignable to parameter of type '{ id: string; kind: "markdown" | "code"; content: string; output: any; ranAt: string | null; }[]'`

2. **Runtime execution**: Tests are skipped when `.venv/bin/python` is missing. The `.venv` environment must be set up with `numpy`, `scipy`, `pandas`, `scikit-learn` for the executed scripts to produce `RESULT:` output.

3. **Nbformat validation**: The `.ipynb` export test fails at `nbformat` validation (exit code 1), indicating the generated JSON document has structural issues not caught by the nbformat library.

## Recommended actions

**Option A — Fix test TypeScript errors:** Update `__tests__/unit/python-export.test.ts` type annotations to match the actual function signatures.

**Option B — Set up .venv and run acceptance tests:** Create a local `.venv` with required dependencies and run the test suite to verify exported scripts produce correct `RESULT:` output.

**Option C — Verify nbformat output:** Inspect `exportNotebookToIpynb` output format and fix any JSON structure issues so nbformat validation passes.

## Verification

After fixes are applied, run:

- `npx tsc --noEmit __tests__/unit/python-export.test.ts` — should have no type errors related to export function signatures
- `npx jest __tests__/unit/python-export.test.ts --no-coverage` — all 5 tests should pass (4 execution + 1 nbformat validation), provided `.venv` is available
- If `.venv` is unavailable, confirm the test suite skips cleanly with `describe.skip` marker
