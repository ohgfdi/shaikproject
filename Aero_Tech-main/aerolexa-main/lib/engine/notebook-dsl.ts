/**
 * Notebook DSL kernel — statistically validated.
 *
 * Ledgerly's notebook runs cells in-browser. When the real Pyodide kernel is
 * unavailable, code cells execute against this deterministic DSL which talks
 * to the user's actual dataset rows. GRADUATION NOTE (was "Prototype / Demo"):
 * every numeric statistic is now computed by the oracle-validated primitives
 * in lib/engine/stats.ts — the same code the Analysis Lab uses, compared
 * against SciPy/NumPy oracles in CI (`__tests__/unit/stats-reference.test.ts`):
 *
 *   %describe  — mean/sum/min/max via stats primitives; Q1/median/Q3 via the
 *                R-type-7 linear-interpolation quantile (the NumPy/SciPy
 *                default, replacing the old floor() picker); sample stddev
 *                (ddof=1, matching np.std default) via two-pass variance.
 *   %corr      — delegates to stats.pearson: the exact t statistic with the
 *                regularized-incomplete-beta Student-t p-value (the same
 *                number scipy.stats.pearsonr reports) — not just r.
 *   %histogram — quantile-based median; sample stddev; bin edges/count.
 *   %kpi/%trend — unchanged aggregation (sum/mean over cleanFinite values).
 *
 * Anything that looks like real Python returns an honest note explaining that
 * the Pyodide kernel is unavailable. Output payloads match NotebookCellOutput and
 * are rendered by the Notebook editor.
 *
 * Dependency-free + unit-tested (notebook-dsl.test.ts + the graduation
 * oracle tests in notebook-dsl-graduation.test.ts).
 */

import { welchTTest } from "@/lib/engine/advisor-analysis";
import {
  bucketByDate,
  bucketLabel,
  cellNumber,
  cellString,
  detectGranularity,
  valueCounts,
  type Cell,
} from "@/lib/engine/dataset";
import { forecastSeries } from "@/lib/engine/forecast";
import {
  mannKendall,
  ols,
  studentTCriticalTwoSided,
  mean as statsMean,
  pearson,
  quantile,
  stddev as statsStddev,
  sum as statsSum,
} from "@/lib/engine/stats";
import type { ColumnDef, NotebookCellOutput } from "@/lib/types";

export interface DslContext {
  datasetName: string;
  columns: ColumnDef[];
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  rowLimit: number; // cap for %rows
}

const PYTHON_MARKERS =
  /^\s*(import|from)\s+(numpy|pandas|matplotlib|seaborn|sklearn|scikit|xgboost|scipy|plotly)|^\s*python|%py\b/;

export function looksLikePython(content: string): boolean {
  return PYTHON_MARKERS.test(content);
}

export function executeNotebookCell(content: string, ctx: DslContext): NotebookCellOutput {
  const code = content.trim();
  if (!code) {
    return {
      type: "error",
      message: "The cell is empty. Type a % command (start with %help) or Python code.",
    };
  }
  if (looksLikePython(code)) {
    return {
      type: "note",
      title: "Pyodide kernel not loaded",
      detail:
        "Python (numpy/pandas/sklearn…) runs on the real Pyodide kernel when it is available. Aerolexa is using the deterministic DSL fallback — type %help to see commands that execute against this dataset's real rows.",
    };
  }

  const firstLine = code.split("\n", 1)[0]?.trim() ?? "";
  const [rawCmd, ...rawArgs] = firstLine.split(/\s+/);
  const cmd = rawCmd?.toLowerCase() ?? "";
  const argStr = rawArgs.join(" ").trim();

  const numeric = (name: string): { idx: number; values: number[] } => {
    const idx = ctx.columns.findIndex((c) => c.name === name);
    if (idx < 0) throw new DslCommandError(`Column “${name}” was not found. Use %columns to list columns.`);
    const values: number[] = [];
    for (const row of ctx.rows) {
      const v = cellNumber(row[idx] as Cell);
      if (Number.isFinite(v)) values.push(v);
    }
    return { idx, values };
  };
  const dateCols = ctx.columns.filter((c) => c.type === "date").map((c) => c.name);

  try {
    switch (cmd) {
      case "%help":
        return {
          type: "text",
          text: [
            "Prototype notebook kernel — deterministic DSL over this dataset.",
            "",
            "  %rows [n]                Preview first n rows",
            "  %profile                 Data-quality overview",
            "  %columns                 Column schema",
            "  %describe <column>       Numeric stats for one column",
            "  %kpi <metricColumn>      Totals, averages, extremes",
            "  %trend <metric> [by <date>]  Line chart over time",
            "",
            "Elite analysis (oracle-validated engines):",
            "  %forecast <metric> [by <date>] [horizon <n>]  ETS/Theta/ARIMA forecast",
            "  %trendtest <metric> [by <date>]  Mann–Kendall monotonic trend test",
            "  %test <colA> <colB>         Welch unequal-variance t-test",
            "  %regress <outcome> <drivers…>  Multivariate OLS + HC1 robust SEs",
            "",
            "Python cells run on the Pyodide kernel when it is available. If it cannot load, the notebook uses this deterministic DSL fallback.",
          ].join("\n"),
        };

      case "%dataset":
        return {
          type: "stats",
          title: "Active dataset",
          stats: [
            { label: "Name", value: ctx.datasetName },
            { label: "Columns", value: String(ctx.columns.length) },
            { label: "Rows", value: ctx.totalRows.toLocaleString() },
          ],
        };

      case "%rows":
      case "%head": {
        const n = Math.max(1, Math.min(parseInt(argStr || "20", 10) || 20, ctx.rowLimit));
        const shown = ctx.rows.slice(0, n);
        return {
          type: "table",
          title: `First ${shown.length} row${shown.length === 1 ? "" : "s"} of ${ctx.totalRows.toLocaleString()}`,
          columns: ctx.columns.map((c) => ({
            key: c.name,
            label: c.name,
            format: c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
          })),
          rows: shown.map((row) => row.map((v) => (v === null ? null : v)) as (string | number | null)[]),
        };
      }

      case "%columns":
        return {
          type: "table",
          title: "Column schema",
          columns: [
            { key: "name", label: "Column" },
            { key: "type", label: "Type" },
          ],
          rows: ctx.columns.map((c) => [c.name, c.type]),
        };

      case "%profile": {
        const stats: { label: string; value: string }[] = [
          { label: "Rows analysed", value: ctx.rows.length.toLocaleString() },
          { label: "Columns", value: String(ctx.columns.length) },
          {
            label: "Date columns",
            value: dateCols.length ? dateCols.join(", ") : "none",
          },
        ];
        const numericCols = ctx.columns.filter((c) => c.type === "number" || c.type === "boolean");
        stats.push({ label: "Numeric columns", value: String(numericCols.length) });
        return {
          type: "stats",
          title: "Dataset profile (computed live from loaded rows)",
          stats,
        };
      }

      case "%describe": {
        if (!argStr) throw new DslCommandError("%describe needs a column name, e.g. %describe revenue");
        const { values } = numeric(argStr);
        if (values.length === 0) throw new DslCommandError(`Column “${argStr}” has no numeric values.`);
        // Oracle-validated primitives (stats.ts): R-type-7 quantiles, sample
        // stddev (ddof=1), two-pass variance — identical to NumPy/SciPy.
        return {
          type: "stats",
          title: `Describe ${argStr} (${values.length.toLocaleString()} values)`,
          stats: [
            { label: "Mean", value: fmt(statsMean(values)) },
            { label: "Sum", value: fmt(statsSum(values)) },
            { label: "Min", value: fmt(Math.min(...values)) },
            { label: "Q1", value: fmt(quantile(values, 0.25)) },
            { label: "Median", value: fmt(quantile(values, 0.5)) },
            { label: "Q3", value: fmt(quantile(values, 0.75)) },
            { label: "Max", value: fmt(Math.max(...values)) },
            { label: "Std dev", value: fmt(statsStddev(values)) },
          ],
        };
      }

      case "%kpi": {
        if (!argStr) throw new DslCommandError("%kpi needs a metric column, e.g. %kpi revenue");
        const { values } = numeric(argStr);
        if (values.length === 0) throw new DslCommandError(`Column “${argStr}” has no numeric values.`);
        const sum = values.reduce((a, b) => a + b, 0);
        const mean = sum / values.length;
        return {
          type: "stats",
          title: `KPI — ${argStr}`,
          stats: [
            { label: "Sum", value: fmt(sum) },
            { label: "Mean", value: fmt(mean) },
            { label: "Count", value: values.length.toLocaleString() },
            { label: "Min", value: fmt(Math.min(...values)) },
            { label: "Max", value: fmt(Math.max(...values)) },
          ],
        };
      }

      case "%trend": {
        const parts = argStr.split(/\s+by\s+/i);
        const metric = (parts[0] ?? "").trim();
        const dateCol = parts[1]?.trim() || dateCols[0];
        if (!metric) throw new DslCommandError("%trend needs a metric, e.g. %trend revenue by date");
        const metricIdx = ctx.columns.findIndex((c) => c.name === metric);
        if (metricIdx < 0)
          throw new DslCommandError(`Metric column “${metric}” not found. Use %columns to list columns.`);
        if (!dateCol) {
          throw new DslCommandError(
            "No date column found — cast a column to Date in the dataset, or pass one: %trend revenue by date",
          );
        }
        const dateIdx = ctx.columns.findIndex((c) => c.name === dateCol);
        if (dateIdx < 0) throw new DslCommandError(`Date column “${dateCol}” not found.`);
        const dates = ctx.rows.map((r) => cellString(r[dateIdx] as Cell)).filter((s) => s !== "");
        const granularity = detectGranularity(new Set(dates).size);
        const points = bucketByDate(
          ctx.rows as (string | number | boolean | null)[][],
          ctx.columns as { name: string; type: "string" | "number" | "date" | "boolean" }[],
          dateCol,
          metric,
          granularity,
        );
        if (points.length === 0) {
          throw new DslCommandError(
            `No usable ${dateCol} × ${metric} pairs were found (missing or non-numeric values).`,
          );
        }
        return {
          type: "chart",
          title: `${metric} by ${dateCol} (${granularity})`,
          chart: {
            kind: "line",
            title: `${metric} over time`,
            subtitle: `Bucketed by ${granularity} — sum of ${metric} per period`,
            xLabel: dateCol,
            yLabel: metric,
            categories: points.map((p) => bucketLabel(p.key, granularity)),
            series: [{ name: metric, data: points.map((p) => Math.round(p.value * 100) / 100) }],
          },
        };
      }

      case "%corr": {
        if (!argStr) throw new DslCommandError("%corr needs two column names, e.g. %corr height weight");
        const [col1Name, col2Name] = argStr.split(/\s+/);
        if (!col1Name || !col2Name) throw new DslCommandError("%corr needs two column names separated by a space");
        const col1Idx = ctx.columns.findIndex((c) => c.name === col1Name);
        const col2Idx = ctx.columns.findIndex((c) => c.name === col2Name);
        if (col1Idx < 0) throw new DslCommandError(`Column “${col1Name}” not found.`);
        if (col2Idx < 0) throw new DslCommandError(`Column “${col2Name}” not found.`);
        const col1Values: number[] = [];
        const col2Values: number[] = [];
        for (const row of ctx.rows) {
          const v1 = cellNumber(row[col1Idx] as Cell);
          const v2 = cellNumber(row[col2Idx] as Cell);
          if (Number.isFinite(v1) && Number.isFinite(v2)) {
            col1Values.push(v1);
            col2Values.push(v2);
          }
        }
        if (col1Values.length < 3) throw new DslCommandError("Not enough numeric pairs for correlation.");
        // Oracle-validated: stats.pearson computes the exact Student-t p-value
        // via the regularized incomplete beta — the same statistic
        // scipy.stats.pearsonr reports (see stats-reference.test.ts).
        const pr = pearson(col1Values, col2Values);
        const mean1 = statsMean(col1Values);
        const mean2 = statsMean(col2Values);
        const std1 = statsStddev(col1Values);
        const std2 = statsStddev(col2Values);
        return {
          type: "stats",
          title: `Correlation: ${col1Name} ↔ ${col2Name}`,
          stats: [
            { label: "Pearson r", value: Number.isFinite(pr.r) ? pr.r.toFixed(4) : "—" },
            { label: "p-value", value: Number.isFinite(pr.r) ? pr.p.toFixed(4) : "—" },
            { label: "n (pairs)", value: pr.n.toLocaleString() },
            { label: "Mean " + col1Name, value: mean1.toFixed(4) },
            { label: "Mean " + col2Name, value: mean2.toFixed(4) },
            { label: "Std " + col1Name, value: std1.toFixed(4) },
            { label: "Std " + col2Name, value: std2.toFixed(4) },
          ],
        };
      }

      // ---------------------------------------------------------------------
      // Elite tier — the same oracle-validated engines the Analysis Lab and
      // the advisor use, addressable from a notebook cell.
      // ---------------------------------------------------------------------

      case "%forecast": {
        // %forecast <metric> [by <date>] [horizon <n>] — ETS/Theta/ARIMA with
        // AICc selection + walk-forward backtest (the real forecast engine).
        const m = /^(?<metric>\S+)(?:\s+by\s+(?<date>\S+))?(?:\s+horizon\s+(?<h>\d+))?\s*$/.exec(argStr);
        if (!m?.groups?.metric) {
          throw new DslCommandError("%forecast needs a metric column, e.g. %forecast revenue by date horizon 3");
        }
        const metric = m.groups.metric;
        const dateCol = m.groups.date || dateCols[0];
        const horizon = Math.min(Math.max(parseInt(m.groups.h || "3", 10) || 3, 1), 12);
        const metricIdx = ctx.columns.findIndex((c) => c.name === metric);
        if (metricIdx < 0)
          throw new DslCommandError(`Metric column “${metric}” not found. Use %columns to list columns.`);
        if (!dateCol) {
          throw new DslCommandError("No date column found — pass one: %forecast revenue by date");
        }
        const dateIdx2 = ctx.columns.findIndex((c) => c.name === dateCol);
        if (dateIdx2 < 0) throw new DslCommandError(`Date column “${dateCol}” not found.`);
        // Bucket metric sums by the detected granularity (same as %trend).
        const datesF = ctx.rows.map((r) => cellString(r[dateIdx2] as Cell)).filter((s) => s !== "");
        const granularity = detectGranularity(new Set(datesF).size);
        const pointsF = bucketByDate(
          ctx.rows as (string | number | boolean | null)[][],
          ctx.columns as { name: string; type: "string" | "number" | "date" | "boolean" }[],
          dateCol,
          metric,
          granularity,
        );
        const values = pointsF.map((p) => p.value);
        if (values.length < 6) {
          throw new DslCommandError(
            `Forecast needs at least 6 ${granularity} buckets of ${metric} — found ${values.length}. Aggregate more history first.`,
          );
        }
        const fit = forecastSeries(values, {
          horizon,
          period: granularity === "month" ? 12 : granularity === "day" ? 7 : 0,
        });
        return {
          type: "stats",
          title: `Forecast: ${metric} — ${fit.best.name} (${fit.best.family.toUpperCase()}), ${horizon} step(s)`,
          stats: [
            { label: "Best model", value: `${fit.best.name} (${fit.best.family.toUpperCase()})` },
            { label: "AICc", value: fit.best.aicc.toFixed(1) },
            { label: "Residual σ", value: fit.best.sigma.toFixed(3) },
            {
              label: "Ljung–Box p (lag 10)",
              value: Number.isFinite(fit.best.ljungBoxP) ? fit.best.ljungBoxP.toFixed(4) : "—",
            },
            { label: "History", value: `${values.length} ${granularity} buckets` },
            ...fit.points.map((p) => ({
              label: `Step +${p.h} (95% PI)`,
              value: `${(Math.round(p.point * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}  [${(Math.round(p.low * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}, ${(Math.round(p.high * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}]`,
            })),
          ],
        };
      }

      case "%trendtest": {
        // %trendtest <metric> [by <date>] — Mann–Kendall monotonic trend test.
        const m = /^(?<metric>\S+)(?:\s+by\s+(?<date>\S+))?\s*$/.exec(argStr);
        if (!m?.groups?.metric)
          throw new DslCommandError("%trendtest needs a metric column, e.g. %trendtest revenue by date");
        const metric = m.groups.metric;
        const dateCol = m.groups.date || dateCols[0];
        if (!dateCol) throw new DslCommandError("No date column found — pass one: %trendtest revenue by date");
        const metricIdx = ctx.columns.findIndex((c) => c.name === metric);
        if (metricIdx < 0)
          throw new DslCommandError(`Metric column “${metric}” not found. Use %columns to list columns.`);
        const dateIdx2 = ctx.columns.findIndex((c) => c.name === dateCol);
        if (dateIdx2 < 0) throw new DslCommandError(`Date column “${dateCol}” not found.`);
        const datesT = ctx.rows.map((r) => cellString(r[dateIdx2] as Cell)).filter((s) => s !== "");
        const granularity = detectGranularity(new Set(datesT).size);
        const pointsT = bucketByDate(
          ctx.rows as (string | number | boolean | null)[][],
          ctx.columns as { name: string; type: "string" | "number" | "date" | "boolean" }[],
          dateCol,
          metric,
          granularity,
        );
        const mk = mannKendall(pointsT.map((p) => p.value));
        return {
          type: "stats",
          title: `Mann–Kendall trend test: ${metric} by ${dateCol} (${granularity})`,
          stats: [
            { label: "Direction", value: mk.direction },
            { label: "p-value", value: mk.p.toFixed(4) },
            { label: "S statistic", value: String(mk.s) },
            { label: "z score", value: mk.z.toFixed(3) },
            { label: "Kendall τ", value: mk.tau.toFixed(3) },
            { label: "Periods", value: String(mk.n) },
          ],
        };
      }

      case "%test": {
        // %test <numericA> <numericB> — Welch's unequal-variance t-test with
        // the exact Student-t p-value (advisor-analysis primitive).
        const [aName, bName] = argStr.split(/\s+/);
        if (!aName || !bName) throw new DslCommandError("%test needs two numeric columns, e.g. %test treated control");
        const grab = (name: string): number[] => {
          const idx = ctx.columns.findIndex((c) => c.name === name);
          if (idx < 0) throw new DslCommandError(`Column “${name}” was not found. Use %columns to list columns.`);
          const vals: number[] = [];
          for (const row of ctx.rows) {
            const v = cellNumber(row[idx] as Cell);
            if (Number.isFinite(v)) vals.push(v);
          }
          return vals;
        };
        const a = grab(aName);
        const b = grab(bName);
        if (a.length < 2 || b.length < 2) throw new DslCommandError("Both columns need at least 2 numeric values.");
        const wt = welchTTest(a, b);
        if (!wt) throw new DslCommandError("The t-test is not computable on these columns (zero variance in both).");
        return {
          type: "stats",
          title: `Welch t-test: ${aName} vs ${bName}`,
          stats: [
            { label: "Mean " + aName, value: statsMean(a).toFixed(4) },
            { label: "Mean " + bName, value: statsMean(b).toFixed(4) },
            { label: "t statistic", value: wt.t.toFixed(4) },
            { label: "p-value", value: wt.p.toFixed(4) },
            { label: "df (Welch–Satterthwaite)", value: wt.df.toFixed(1) },
            { label: "n", value: `${a.length} vs ${b.length}` },
            { label: "Verdict (α=0.05)", value: wt.p < 0.05 ? "means differ for real" : "difference is within noise" },
          ],
        };
      }

      case "%regress": {
        // %regress <outcome> <driver1> [driver2 …] — multivariate OLS with the
        // exact Student-t inference AND HC1 robust standard errors.
        const names = argStr.split(/\s+/).filter(Boolean);
        if (names.length < 2)
          throw new DslCommandError("%regress needs an outcome and at least one driver, e.g. %regress margin price");
        const [outcomeName, ...driverNames] = names as [string, ...string[]];
        const colIdx = (name: string): number => {
          const idx = ctx.columns.findIndex((c) => c.name === name);
          if (idx < 0) throw new DslCommandError(`Column “${name}” was not found. Use %columns to list columns.`);
          return idx;
        };
        const outcomeIdx = colIdx(outcomeName);
        const driverIdxs = driverNames.map(colIdx);
        const X: number[][] = [];
        const y: number[] = [];
        for (const row of ctx.rows) {
          const yi = cellNumber(row[outcomeIdx] as Cell);
          const xs = driverIdxs.map((i) => cellNumber(row[i] as Cell));
          if (!Number.isFinite(yi) || xs.some((v) => !Number.isFinite(v))) continue;
          X.push(xs);
          y.push(yi);
        }
        if (X.length < 8)
          throw new DslCommandError("%regress needs at least 8 complete rows (outcome + every driver present).");
        const fit = ols(X, y);
        if (!fit) {
          throw new DslCommandError(
            "The regression is not estimable — a driver is constant or perfectly collinear with the others.",
          );
        }
        const p = fit.coefficients.length;
        const df = X.length - p - 1;
        const tCrit = studentTCriticalTwoSided(0.05, df);
        return {
          type: "stats",
          title: `OLS regression: ${outcomeName} ~ ${driverNames.join(" + ")} (n = ${X.length})`,
          stats: [
            { label: "R²", value: fit.rSquared.toFixed(4) },
            ...driverNames.flatMap((name, j) => {
              const b = fit.coefficients[j] as number;
              const se = fit.standardErrors[j] as number;
              const seHC1 = fit.hc1StandardErrors[j] as number;
              const pClassical = fit.pValues[j] as number;
              const pHC1 = fit.hc1PValues[j] as number;
              return [
                { label: `${name} — coefficient`, value: b.toFixed(4) },
                { label: `${name} — SE (classical)`, value: se.toFixed(4) },
                { label: `${name} — SE (HC1 robust)`, value: seHC1.toFixed(4) },
                { label: `${name} — p (classical)`, value: pClassical.toFixed(4) },
                { label: `${name} — p (HC1)`, value: pHC1.toFixed(4) },
                {
                  label: `${name} — 95% interval`,
                  value: `[${(b - tCrit * se).toFixed(4)}, ${(b + tCrit * se).toFixed(4)}]`,
                },
              ];
            }),
          ],
        };
      }

      case "%histogram": {
        if (!argStr) throw new DslCommandError("%histogram needs a column name, e.g. %histogram revenue");
        const colIdx = ctx.columns.findIndex((c) => c.name === argStr);
        if (colIdx < 0) throw new DslCommandError(`Column “${argStr}” not found.`);
        const values: number[] = [];
        for (const row of ctx.rows) {
          const v = cellNumber(row[colIdx] as Cell);
          if (Number.isFinite(v)) values.push(v);
        }
        if (values.length === 0) throw new DslCommandError(`Column “${argStr}” has no numeric values.`);
        const sorted = [...values].sort((a, b) => a - b);
        const min = Math.min(...sorted);
        const max = Math.max(...sorted);
        const binCount = Math.min(10, Math.ceil(Math.sqrt(values.length)));
        const binWidth = (max - min) / binCount;
        const bins: number[] = [];
        for (let i = 0; i <= binCount; i++) {
          bins.push(min + i * binWidth);
        }
        const binCounts: number[] = new Array(binCount).fill(0);
        for (const v of values) {
          const binIdx = Math.min(Math.max(0, Math.floor((v - min) / binWidth)), binCount - 1);
          binCounts[binIdx] = (binCounts[binIdx] as number) + 1;
        }
        return {
          type: "stats",
          title: `Histogram: ${argStr}`,
          stats: [
            { label: "Min", value: min.toFixed(4) },
            { label: "Max", value: max.toFixed(4) },
            { label: "Mean", value: statsMean(values).toFixed(4) },
            { label: "Median", value: quantile(values, 0.5).toFixed(4) },
            { label: "Std dev", value: statsStddev(values).toFixed(4) },
          ],
          histogram: { bins, binCounts },
        };
      }

      default: {
        const counts = valueCounts(
          ctx.rows.map((row) => cellString(row[0] as Cell)),
          5,
        );
        void counts;
        if (firstLine.startsWith("%")) {
          return {
            type: "error",
            message: `Unknown command “${firstLine}”. Run %help to see the supported commands.`,
          };
        }
        return {
          type: "note",
          title: "Not executed by the DSL kernel",
          detail:
            "This cell is neither a % command nor importable Python. Start a line with % (see %help) to compute against this dataset, or enable the Pyodide kernel for Python.",
        };
      }
    }
  } catch (err) {
    if (err instanceof DslCommandError) {
      return { type: "error", message: err.message };
    }
    return {
      type: "error",
      message: `The command failed unexpectedly: ${err instanceof Error ? err.message : "unknown error"}.`,
    };
  }
}

class DslCommandError extends Error {}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e6) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Kernel banner for callers that render the DSL directly. */
export const NOTEBOOK_KERNEL_NOTE =
  "Deterministic DSL kernel: statistically validated commands (SciPy-oracle-tested primitives) execute against this dataset's rows when the Pyodide kernel is unavailable.";
