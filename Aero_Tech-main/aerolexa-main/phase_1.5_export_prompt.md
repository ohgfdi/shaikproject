# Phase 1.5 — Export Runnable Python Module Status

## Issue Summary

The `@/lib/export/python` module **exists** and has a real implementation (found at `lib/export/python.ts`), but the generated Python scripts contain syntax errors that prevent actual execution. This was discovered during the Tier 1.5 TypeScript check when `python-export.test.ts` ran and all 4 "executed Python export" tests failed.

## Root Cause

The `exportAnalysisScript`, `exportWhatIfScript`, `exportModelScript`, and `exportHypothesisScript` functions generate Python source code as strings, but the generated scripts have `SyntaxError: unterminated triple-quoted string literal` errors at line 1-24 of the exported script. The `.ipynb` nbformat validation also shows 1 discrepancy.

### Failed Test Details

| Test                                                                         | Error                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `what-if: exported OLS script matches the engine result exactly`             | `SyntaxError: unterminated triple-quoted string literal (detected at line 23)` |
| `model: exported linear-regression script reproduces test metrics + weights` | `SyntaxError: unterminated triple-quoted string literal (detected at line 20)` |
| `analysis: exported KPI script recomputes the same sum the app displayed`    | `SyntaxError: unterminated triple-quoted string literal (detected at line 24)` |
| `exported .ipynb documents are valid Jupyter notebooks`                      | nbformat validation fails (1 discrepancy expected vs received)                 |

## Module Status

| Component                     | Status                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `lib/export/python.ts` module | ✅ EXISTS — real implementation with 5 export functions              |
| `exportAnalysisScript`        | ✅ Generates script string, but script has syntax error              |
| `exportWhatIfScript`          | ✅ Generates script string, but script has syntax error              |
| `exportModelScript`           | ✅ Generates script string, but script has syntax error              |
| `exportHypothesisScript`      | ✅ Generates script string, but script has syntax error              |
| `exportNotebookToIpynb`       | ✅ Generates nbformat JSON, but validation discrepancy               |
| **Actual Python execution**   | ❌ **FAILS** — scripts cannot parse due to triple-quote syntax error |

## Test Evidence

```
$ npx jest --runInBand --testPathPattern='__tests__/unit/python-export'
FAIL __tests__/unit/python-export.test.ts
  executed Python exports reproduce the app's numbers
    ✕ what-if: exported OLS script matches the engine result exactly
    ✕ model: exported linear-regression script reproduces test metrics + weights
    ✕ hypothesis: exported scipy t-test matches the engine's statistic and p-value
    ✕ analysis: exported KPI script recomputes the same sum the app displayed
  exported .ipynb documents are valid Jupyter notebooks
    ✕ passes nbformat validation with cells + outputs preserved
```

## Required Fix

The generated Python scripts need their triple-quoted docstring syntax fixed. Each function generates `"""` at the start but the closing `"""` or the string content management has a bug causing `unterminated triple-quoted string literal`. The scripts need to be revised so that:

1. Docstrings are properly terminated
2. String interpolation (especially `${JSON.stringify(...)}`) doesn't break Python triple-quote parsing
3. Exported scripts actually execute in a clean Python environment and reproduce the app's numeric results

## Verification Gate

Until the exported Python scripts parse and execute without `SyntaxError`, Phase 1.5 code export cannot be considered **REAL**. The versioning component (15/15 tests passing) is real and working, but the "Export runnable code" feature (1.5's headline feature) is **PARTIAL** — scripts generate but cannot execute.

## Related

- `__tests__/unit/python-export.test.ts` — 5 tests, all failing due to script syntax errors
- `lib/export/python.ts` — the module with the buggy script generation
- `phase_1.5_verification_prompt.md` — (previous verification prompt from earlier project phase)
