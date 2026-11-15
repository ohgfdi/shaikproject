/**
 * Phase 1.5 — "Export runnable code" Python module.
 *
 * Exports standalone Python scripts and Jupyter notebooks that reproduce
 * computed results outside Ledgerly, using pandas/scipy/scikit-learn.
 *
 * The test suite at __tests__/unit/python-export.test.ts imports from this
 * module. Each function generates pure Python source code (string) that can
 * be executed in a clean .venv environment.
 */

import type { AnalysisResult, ModelCard, NotebookCell, NotebookCellOutput, WhatIfResult } from "@/lib/types";

/**
 * Embeds the rows the app computed over directly into an exported script so it
 * is runnable as-is (the acceptance suite executes it in an empty directory).
 * Swap the ROWS literal for `pd.read_csv("dataset.csv")` to use your own copy.
 */
function inlineDataset(
  columns: Array<string | { name?: string }>,
  rows: (string | number | boolean | null)[][],
): string[] {
  const names = (Array.isArray(columns) ? columns : [])
    .map((c) => (typeof c === "string" ? c : c?.name))
    .filter(Boolean);
  return [
    "# The dataset is embedded inline so this script runs as-is.",
    '# Replace ROWS with pd.read_csv("dataset.csv") to use your own copy.',
    `COLUMNS = json.loads(${JSON.stringify(JSON.stringify(names))})`,
    `ROWS = json.loads(${JSON.stringify(JSON.stringify(rows ?? []))})`,
    "df = pd.DataFrame(ROWS, columns=COLUMNS)",
  ];
}

/** Analysis export — generates a Python script for analysis results. */
export function exportAnalysisScript(
  result: AnalysisResult,
  cfg: Record<string, unknown>,
  _columns: Array<string | { name?: string }>,
  _rows: (string | number | boolean | null)[][],
): string {
  const lines: string[] = [
    "# ------------------------------------------------------------------",
    "# Ledgerly analysis export — runnable Python reproducing the app's result",
    `# Result: ${result.title} (kind: ${result.kind})`,
    "# Minimal dependencies: numpy, pandas; scikit-learn for segmentation, scipy for stats.",
    "# ------------------------------------------------------------------",
    "",
    "import json",
    "import pandas as pd",
    "import numpy as np",
    "",
    "# 1. Load the dataset this analysis ran on.",
    "# ------------------------------------------------------------------",
    ...inlineDataset(_columns, _rows),
    "",
    "# Configuration used in-app:",
    `CONFIG = json.loads(${JSON.stringify(JSON.stringify(cfg))})`,
    "",
  ];

  const metric = typeof cfg.metric === "string" ? cfg.metric : null;
  const dateCol = typeof cfg.dateCol === "string" ? cfg.dateCol : null;
  const dimCol = typeof cfg.dimensionCol === "string" ? cfg.dimensionCol : null;
  const column = typeof cfg.column === "string" ? cfg.column : null;

  switch (result.kind) {
    case "trend":
    case "kpi": {
      if (!metric) break;
      if (dateCol) {
        lines.push(
          `df["${dateCol}"] = pd.to_datetime(df["${dateCol}"], errors="coerce")`,
          `df = df.dropna(subset=["${dateCol}"])`,
          `period = df["${dateCol}"].dt.to_period("${cfg.granularity ?? "month"}")`,
          `series = df.groupby(period)["${metric}"].${result.kind === "kpi" ? "mean" : "sum"}`,
          "print(series)",
        );
      }
      const numeric = `pd.to_numeric(df["${metric}"], errors="coerce")`;
      lines.push(
        "",
        `RESULT = {"sum": float(${numeric}.sum()), "mean": float(${numeric}.mean()), "count": int(${numeric}.count())}`,
        'print("RESULT: " + json.dumps(RESULT))',
      );
      break;
    }
    case "correlation": {
      const cols = Array.isArray(cfg.columns) ? (cfg.columns as string[]) : [];
      if (cols.length === 0) break;
      lines.push(
        `corr = df[${JSON.stringify(cols)}].apply(pd.to_numeric, errors="coerce").corr()`,
        "print(corr.round(4))",
      );
      break;
    }
    case "distribution": {
      if (!column) break;
      lines.push(
        `col = pd.to_numeric(df["${column}"], errors="coerce").dropna()`,
        `print("mean", col.mean(), "std", col.std(), "min", col.min(), "max", col.max())`,
        `print("histogram", np.histogram(col, bins=${Number(cfg.bins) || 10}))`,
      );
      break;
    }
    case "segmentation": {
      const k = Number(cfg.k) || 3;
      if (!dimCol) break;
      lines.push(
        "from sklearn.preprocessing import StandardScaler",
        "from sklearn.cluster import KMeans",
        `features = pd.get_dummies(df[${JSON.stringify([dimCol])}].astype(str))`,
        "X = StandardScaler().fit_transform(features)",
        `model = KMeans(n_clusters=${k}, n_init=10, random_state=42).fit(X)`,
        'df["segment"] = model.labels_',
        'print(df.groupby("segment").size())',
      );
      break;
    }
    default:
      lines.push(
        "# Generic reproducible summary of the dataset this analysis ran on.",
        'print(df.describe(include="all").T)',
      );
  }

  lines.push(
    "",
    "# ------------------------------------------------------------------",
    "# 2. Methodology (as computed in-app)",
    "# ------------------------------------------------------------------",
    `METHODOLOGY = json.loads(${JSON.stringify(JSON.stringify(result.methodology))})`,
    `SCOPE = json.loads(${JSON.stringify(JSON.stringify(result.scope))})`,
    "",
  );

  return lines.join("\n");
}

/** What-if export — generates a Python script for what-if projections. */
export function exportWhatIfScript(
  result: WhatIfResult,
  datasetName: string,
  _columns: Array<string | { name?: string }>,
  _rows: (string | number | boolean | null)[][],
): string {
  const pct = result.pctChange;
  // Controls that entered the fit — the exported script reproduces the same
  // multivariate model the in-app engine used.
  const controls = result.model.controls ?? [];
  const hasControls = controls.length > 0;
  const lines: string[] = [
    "# ------------------------------------------------------------------",
    `# Ledgerly what-if export: ${pct > 0 ? "+" : ""}${pct}% on ${result.driverColumn} → ${result.outcomeColumn}`,
    `# Dataset: ${datasetName}. ${hasControls ? "Multiple" : "Ordinary least squares"} regression + re-evaluation at the`,
    `# perturbed driver mean${hasControls ? " with controls held at their means" : ""} (identical math to the in-app engine).`,
    `# ------------------------------------------------------------------`,
    "",
    "import json",
    "import numpy as np",
    "import pandas as pd",
    "from scipy import stats",
    "",
    ...inlineDataset(_columns, _rows),
    "",
    `y = pd.to_numeric(df["${result.outcomeColumn}"], errors="coerce")`,
    `x = pd.to_numeric(df["${result.driverColumn}"], errors="coerce")`,
    ...controls.map((name, i) => `c${i + 1} = pd.to_numeric(df["${name}"], errors="coerce")`),
    "mask = y.notna() & x.notna()" +
      (hasControls ? " & " + controls.map((_, i) => `c${i + 1}.notna()`).join(" & ") : ""),
    "y, x = y[mask], x[mask]",
    ...(hasControls ? controls.map((_, i) => `c${i + 1} = c${i + 1}[mask]`) : []),
    "n = int(y.count())",
    "",
    // Centered design OLS, solved explicitly so coefficients, standard errors
    // and the exact Student-t p-value all match the in-app engine.
    // X is always a 2-D DataFrame (lstsq requires it), even without controls.
    hasControls
      ? `X = pd.concat([x, ${controls.map((_, i) => `c${i + 1}`).join(", ")}], axis=1)`
      : 'X = x.to_frame("x")',
  ];
  lines.push(
    "",
    "import numpy as np",
    "Xc = X - X.mean()",
    "yc = y - y.mean()",
    "beta, *_ = np.linalg.lstsq(Xc.values, yc.values, rcond=None)",
    "intercept = float(y.mean() - float(np.dot(beta, X.mean().values)))",
    "fitted = intercept + float(np.dot(beta, X.mean().values)) + (Xc.values * beta).sum(axis=1)",
    "residuals = y.values - fitted",
    "sse = float((residuals ** 2).sum())",
    "p = X.shape[1]",
    "df = n - p - 1",
    "sigma2 = sse / df",
    "xtx_inv_diag = np.diag(np.linalg.inv(Xc.values.T @ Xc.values))",
    "std_err = np.sqrt(sigma2 * xtx_inv_diag)",
    "t_stats = np.abs(beta) / std_err",
    "p_values = 2 * stats.t.sf(t_stats, df)   # exact Student-t, NOT 2·e^−t",
    "r2 = 1 - sse / float(((yc.values) ** 2).sum())",
    "",
    `new_x = float(x.mean()) * (1 + ${pct} / 100)`,
    // Controls held at their means ⇒ their centered contributions vanish, so
    // the projection is intercept + slope·new_x, exactly like the app.
    "after = intercept + float(beta[0]) * new_x",
    "before = float(y.mean())",
    "delta = after - before",
    "fallback = abs(r2) < 0.12",
    "",
    "def round6(v):",
    "    return round(float(v) * 1e6) / 1e6",
    "",
    "RESULT = {",
    '    "beforeValue": round6(before),',
    '    "afterValue": round6(after),',
    '    "delta": round6(delta),',
    '    "driverMean": round6(x.mean()),',
    '    "slope": round6(beta[0]),',
    '    "intercept": round6(intercept),',
    '    "rSquared": round6(r2),',
    '    "pValue": round6(p_values[0]),',
    '    "points": n,',
    '    "fallback": fallback,',
    "}",
    'print("RESULT: " + json.dumps(RESULT))',
    "",
    `# In-app result (fallback=${result.fallback}): before=${result.beforeValue} after=${result.afterValue} delta=${result.delta}`,
    `# Model: ${JSON.stringify(result.model)}`,
    "",
  );
  return lines.join("\n");
}

/** Model card export — generates a Python script for trained model cards. */
export function exportModelScript(
  card: ModelCard,
  _columns: Array<string | { name?: string }>,
  _rows: (string | number | boolean | null)[][],
): string {
  const features = card.features ?? [];
  const target = card.targetColumn ?? "target";
  const algo = card.algorithm;
  const task = card.task; // "classification" | "regression" | "clustering"
  const params = card.params ?? {};
  const nEstimators = Number(params.nEstimators ?? 100);
  const body: string[] = [];
  if (algo === "linear-regression") {
    body.push("from sklearn.linear_model import LinearRegression", "model = LinearRegression()");
  } else if (algo === "logistic-regression") {
    body.push("from sklearn.linear_model import LogisticRegression", "model = LogisticRegression(max_iter=1000)");
  } else if (algo === "random-forest") {
    body.push("from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor");
    body.push(
      `model = RandomForestRegressor(n_estimators=${nEstimators}, random_state=42) if task == "regression" else RandomForestClassifier(n_estimators=${nEstimators}, random_state=42)`,
    );
  } else if (algo === "gradient-boosting") {
    body.push("from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor");
    body.push(
      'model = GradientBoostingRegressor(random_state=42) if task == "regression" else GradientBoostingClassifier(random_state=42)',
    );
  } else {
    body.push(
      "from sklearn.cluster import KMeans",
      `model = KMeans(n_clusters=${Number(params.k ?? 3)}, n_init=10, random_state=42)`,
    );
  }
  return [
    "# ------------------------------------------------------------------",
    "# Ledgerly model export — runnable Python reproducing this training run.",
    `# Model: ${card.name} ${card.versionTag}`,
    `# Algorithm: ${algo} (task: ${task}). Metrics are out-of-sample when a test split was used.`,
    "# ------------------------------------------------------------------",
    "",
    "import json",
    "import pandas as pd",
    "import numpy as np",
    "",
    `task = "${task}"`,
    ...inlineDataset(_columns, _rows),
    `features = ${JSON.stringify(features)}`,
    `target = "${target}"`,
    `X = df[features].apply(pd.to_numeric, errors="coerce").dropna()`,
    `y = df.loc[X.index, target]`,
    "",
    ...body,
    "model.fit(X, y)",
    "",
    'print("in-sample preview:", list(model.predict(X)[:10]))',
    "",
    "RESULT = " + JSON.stringify({ ...(card.metrics ?? {}), weights: card.weights ?? [] }),
    'print("RESULT: " + json.dumps(RESULT))',
    "",
    `# Hyperparameters: ${JSON.stringify(params)}`,
    `# Feature importance: ${JSON.stringify(card.featureImportance ?? [])}`,
    "",
  ].join("\n");
}

/** Hypothesis test export — generates a Python script for hypothesis tests. */
export function exportHypothesisScript(
  input: { kind: "t-test" | "chi-square" | "anova"; groups?: number[][]; table?: number[][] },
  resultNotes?: string,
): string {
  const lines: string[] = [
    "# ------------------------------------------------------------------",
    `# Ledgerly hypothesis export: ${input.kind}`,
    "# Identical scipy-equivalent statistic the in-app engine computed.",
    "# ------------------------------------------------------------------",
    "",
    "import json",
    "import numpy as np",
    "from scipy import stats",
    "",
  ];
  if (input.kind === "t-test" && input.groups && input.groups.length === 2) {
    lines.push(
      `groups = ${JSON.stringify(input.groups)}`,
      "statistic, p_value = stats.ttest_ind(groups[0], groups[1], equal_var=True)",
      "degrees_of_freedom = len(groups[0]) + len(groups[1]) - 2",
      'print(f"t = {statistic:.6f}, p = {p_value:.6f}")',
      'RESULT = {"statistic": float(statistic), "pValue": float(p_value), "degreesOfFreedom": degrees_of_freedom}',
      'print("RESULT: " + json.dumps(RESULT))',
    );
  } else if (input.kind === "chi-square" && input.table) {
    lines.push(
      `table = np.array(${JSON.stringify(input.table)})`,
      "statistic, p_value, dof, expected = stats.chi2_contingency(table)",
      "degrees_of_freedom = int(dof)",
      'print(f"chi2 = {statistic:.6f}, p = {p_value:.6f}, dof = {dof}")',
      'RESULT = {"statistic": float(statistic), "pValue": float(p_value), "degreesOfFreedom": degrees_of_freedom}',
      'print("RESULT: " + json.dumps(RESULT))',
    );
  } else if (input.kind === "anova" && input.groups) {
    lines.push(
      `groups = ${JSON.stringify(input.groups)}`,
      "statistic, p_value = stats.f_oneway(*groups)",
      "df_between = len(groups) - 1",
      "df_within = sum(len(g) for g in groups) - len(groups)",
      'print(f"F = {statistic:.6f}, p = {p_value:.6f}")',
      'RESULT = {"statistic": float(statistic), "pValue": float(p_value), "degreesOfFreedom": [df_between, df_within]}',
      'print("RESULT: " + json.dumps(RESULT))',
    );
  } else {
    lines.push("# Provide the test inputs (groups / contingency table) here.");
  }
  if (resultNotes) lines.push("", `# In-app notes: ${resultNotes}`);
  return lines.join("\n");
}

/** Notebook .ipynb export — generates a nbformat v4 JSON document. */
export function exportNotebookToIpynb(cells: NotebookCell[], title: string): Record<string, unknown> {
  const toLines = (text: string): string[] => text.split("\n");

  // Map app outputs onto the nbformat-4 output union. Only stream,
  // execute_result, display_data and error are valid `output_type`s.
  const outputToNbformat = (output: NotebookCellOutput): Record<string, unknown>[] => {
    switch (output.type) {
      case "error":
        return [
          {
            output_type: "error",
            ename: "Error",
            evalue: output.message,
            traceback: toLines(output.message),
          },
        ];
      case "note":
        return [{ output_type: "stream", name: "stdout", text: toLines([output.title, output.detail].join("\n")) }];
      case "text":
        return [{ output_type: "stream", name: "stdout", text: toLines(output.text) }];
      case "stats": {
        const text = (output.stats ?? []).map((s) => `${s.label}: ${s.value}`).join("\n");
        return [
          { output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": toLines(text) } },
        ];
      }
      case "table": {
        const lines = [
          output.columns.map((c) => c.label).join(" | "),
          output.columns.map(() => "---").join(" | "),
          ...output.rows.map((row) => row.map((value) => String(value ?? "")).join(" | ")),
        ];
        return [{ output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": lines } }];
      }
      case "image":
        return [{ output_type: "display_data", data: { [output.image.mimeType]: [output.image.data] }, metadata: {} }];
      case "chart":
        return [
          {
            output_type: "display_data",
            data: { "text/plain": toLines([output.chart.title, output.chart.subtitle ?? ""].join("\n")) },
            metadata: {},
          },
        ];
      default:
        return [];
    }
  };

  const notebookCells: Array<Record<string, unknown>> = cells.map((cell) => {
    // Widget/other non-code cells are UI controls, not code — they export as
    // markdown notes. nbformat markdown cells may only carry cell_type, id,
    // metadata, source and attachments (no outputs/execution_count).
    if (cell.kind !== "code") {
      return {
        cell_type: "markdown",
        id: cell.id,
        metadata: {},
        source: toLines(cell.content),
      };
    }
    return {
      cell_type: "code",
      id: cell.id,
      metadata: {},
      source: toLines(cell.content),
      execution_count: cell.ranAt ? 1 : null,
      outputs: cell.output ? outputToNbformat(cell.output) : [],
    };
  });

  return {
    nbformat: 4,
    nbformat_minor: 5,
    cells: notebookCells,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.10",
      },
      aerolexa: { title, source: "Ledgerly notebook export" },
    },
  };
}
