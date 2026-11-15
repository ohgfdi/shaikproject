"use strict";

/**
 * Server-side Python kernel — worker bootstrap (plain JS: it is loaded by
 * `new Worker(...)` in the manager below and must not pass through the
 * Next.js/SWC pipeline).
 *
 * What actually runs here:
 * - The real Pyodide distribution (npm package, wasm) — CPython 3.14 compiled
 *   to wasm32, with numpy/pandas/scipy/sklearn/matplotlib/statsmodels wheels
 *   loadable from the local node_modules cache or the Pyodide CDN.
 * - One Python namespace per worker; the manager resets it between cells.
 *
 * Security posture (stated honestly in the UI):
 * - No filesystem access (in-memory FS only), no sockets, no subprocesses.
 *   Pyodide's wasm sandbox cannot open network connections or touch the
 *   server's disk — the cell runs on the same trust boundary as the rest of
 *   the Node process, but it cannot escape it.
 * - The worker is terminated on timeout by the manager; the bootstrap only
 *   needs to stay responsive while a cell runs.
 */

const { parentPort, workerData } = require("node:worker_threads");

// Pyodide's node loader uses `ws` for the standard-library networking shims;
// it must resolve from the app's node_modules, not the worker's evaluation
// context, so the path is passed in via workerData.
module.paths.unshift(workerData.pyodideNodeModules);
const { loadPyodide } = require("pyodide");

let pyodide = null;
let readyPromise = null;

const PRELUDE = `
import sys, json, io, base64, ast, codeop
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def __aerolexa_prepare__(dataset_json, columns_json, extra_json):
    import pandas as pd
    import numpy as np
    global df, __aerolexa_columns__, __aerolexa_extras__
    df = pd.DataFrame(json.loads(dataset_json), columns=json.loads(columns_json))
    for c in df.columns:
        s = df[c]
        if s.dtype == object:
            coerced = pd.to_numeric(s, errors="coerce")
            if coerced.notna().sum() > 0:
                df[c] = coerced.where(coerced.notna(), s)
    __aerolexa_columns__ = list(df.columns)
    __aerolexa_extras__ = {}
    extra = json.loads(extra_json) if extra_json else {}
    for name, pair in extra.items():
        rows, cols = pair["rows"], pair["columns"]
        safe = "".join(ch for ch in name if ch.isalnum() or ch == "_") or "dataset"
        globals()["df_" + safe] = pd.DataFrame(json.loads(rows), columns=json.loads(cols))
        __aerolexa_extras__[name] = "df_" + safe
    return True

def __aerolexa_run_cell__(source):
    """Execute one cell: last expression becomes the repr result, any open
    matplotlib figure is captured as base64 PNG. Raises on Python errors."""
    tree = ast.parse(source)
    result = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        pre = ast.Module(body=tree.body[:-1], type_ignores=[])
        exec(compile(pre, "<cell>", "exec"), globals(), globals())
        result = eval(
            compile(ast.Expression(tree.body[-1].value), "<cell>", "eval"),
            globals(), globals())
    else:
        exec(compile(tree, "<cell>", "exec"), globals(), globals())
    image = None
    if plt.get_fignums():
        buf = io.BytesIO()
        plt.gcf().savefig(buf, format="png", bbox_inches="tight", dpi=110)
        image = base64.b64encode(buf.getvalue()).decode("ascii")
        plt.close("all")
    return {"text": repr(result) if result is not None else None,
            "image": image}
`;

function post(msg) {
  parentPort.postMessage(msg);
}

async function init() {
  const t0 = Date.now();
  pyodide = await loadPyodide({
    indexURL: workerData.indexURL,
    lockFileURL: workerData.lockFileURL,
  });
  pyodide.setStdout({ batched: (s) => post({ type: "stdout", text: s }) });
  pyodide.setStderr({ batched: (s) => post({ type: "stderr", text: s }) });
  // Core wheels load once at boot (downloaded on first use, then served from
  // the node_modules cache). Heavy optional wheels (scipy, scikit-learn,
  // statsmodels) load per cell based on the code's imports.
  await pyodide.loadPackage(["numpy", "pandas", "matplotlib"]);
  await pyodide.runPythonAsync(PRELUDE);
  post({ type: "ready", bootMs: Date.now() - t0 });
}

/**
 * Which optional heavy wheels the requested code needs. Pyodide resolves
 * dependencies transitively via its lockfile, so listing the top-level names
 * is enough (e.g. "sklearn" pulls scipy + jobbin + threadpoolctl).
 */
function packagesFor(code) {
  const pkgs = new Set(["numpy", "pandas", "matplotlib"]);
  if (/\bimport\s+scipy|from\s+scipy\b/.test(code)) pkgs.add("scipy");
  if (/\bimport\s+sklearn|from\s+sklearn\b/.test(code)) pkgs.add("scikit-learn");
  if (/\bimport\s+statsmodels|from\s+statsmodels\b/.test(code)) pkgs.add("statsmodels");
  if (/\bimport\s+PIL|from\s+PIL\b/.test(code)) pkgs.add("pillow");
  return [...pkgs];
}

async function runCell(payload) {
  const { code, dataset, extras } = payload;
  if (!code || !code.trim()) {
    return { ok: false, error: "The cell is empty. Add Python code and run it." };
  }
  try {
    await pyodide
      .loadPackagesFromImports(code, {
        messageCallback: () => undefined,
      })
      .catch(() => undefined);
    const wanted = packagesFor(code);
    await pyodide.loadPackage(wanted).catch(() => undefined);

    if (dataset) {
      pyodide.globals.set("__aerolexa_dataset_json__", JSON.stringify(dataset.rows));
      pyodide.globals.set("__aerolexa_columns_json__", JSON.stringify(dataset.columns.map((c) => c.name)));
    }
    const extrasJson = JSON.stringify(extras ?? {});
    pyodide.globals.set("__aerolexa_extras_json__", extrasJson);
    await pyodide.runPythonAsync(
      dataset
        ? "__aerolexa_prepare__(__aerolexa_dataset_json__, __aerolexa_columns_json__, __aerolexa_extras_json__)"
        : "__aerolexa_prepare__('[]', '[]', __aerolexa_extras_json__)",
    );

    const stdoutLines = [];
    const onStdout = (s) => stdoutLines.push(s);
    pyodide.setStdout({ batched: onStdout });
    pyodide.setStderr({ batched: onStdout });

    pyodide.globals.set("__aerolexa_source__", code);
    // The cell result crosses the wasm boundary as one JSON string — no PyProxy
    // lifetime pitfalls, and a dict repr can never masquerade as structure.
    const rawJson = await pyodide.runPythonAsync("json.dumps(__aerolexa_run_cell__(__aerolexa_source__))");
    const out = JSON.parse(String(rawJson));
    const text = String(out.text ?? "");
    const image = typeof out.image === "string" ? out.image : null;

    if (image) return { ok: true, type: "image", data: image };
    const printed = stdoutLines.join("\n").trim();
    const value = text && text !== "None" ? text : "";
    if (printed && value) return { ok: true, type: "text", text: `${printed}\n${value}` };
    return { ok: true, type: "text", text: printed || value || "Executed successfully." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Python execution failed: ${message.slice(0, 2000)}. How to fix: check the traceback, correct the code, and run the cell again.`,
    };
  } finally {
    try {
      await pyodide.runPythonAsync(`
import matplotlib.pyplot as plt
plt.close("all")
del globals()["__aerolexa_source__"]
`);
    } catch {
      // namespace cleanup is best-effort; the manager resets hard between cells
    }
  }
}

readyPromise = init();

parentPort.on("message", async (msg) => {
  if (msg.type === "run") {
    try {
      await readyPromise;
      const result = await runCell(msg.payload);
      post({ type: "result", id: msg.id, result });
    } catch (err) {
      post({
        type: "result",
        id: msg.id,
        result: {
          ok: false,
          error: `Python kernel failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
});

post({ type: "booted" });
