import type { DslContext } from "@/lib/engine/notebook-dsl";
import { publicEnv } from "@/lib/env-public";
import type { NotebookCellOutput } from "@/lib/types";

const DEFAULT_PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";

const CORE_PYODIDE_PACKAGES = ["numpy", "pandas", "matplotlib"];

/** Storage key for IndexedDB package cache */
const PACKAGE_CACHE_KEY = "Ledgerly-pyodide-package-cache";

export interface PyodideRuntime {
  globals: {
    set(name: string, value: unknown): void;
    get(name: string): unknown;
  };
  loadPackage(packages: string[]): Promise<void>;
  runPythonAsync(code: string): Promise<unknown>;
  setStdout?: (options: { batched: (output: string) => void }) => void;
  setStderr?: (options: { batched: (output: string) => void }) => void;
}

/**
 * Minimal interface for Pyodide proxy objects returned by `runtime.globals.get()`.
 * Pyodide wraps non-primitive JS values in a `PyProxy` which exposes `.toJs()`.
 */
interface PyodideProxy {
  toJs(): unknown;
}

/** Type of the global `loadPyodide` function injected by the Pyodide CDN script. */
interface PyodideLoader {
  (options?: { indexURL?: string }): Promise<PyodideRuntime>;
}

/** Augmented Window that may carry the Pyodide CDN loader. */
interface PyodideWindow extends Window {
  loadPyodide?: PyodideLoader;
}

export interface PyodideKernel {
  ready: Promise<void>;
  run(code: string): Promise<NotebookCellOutput>;
}

export interface PyodideDataset {
  name: string;
  columns: { name: string }[];
  rows: (string | number | boolean | null)[][];
}

/** Returns the set of currently cached package names from IndexedDB/localStorage. */
function getCachedPackageNames(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const cached = localStorage.getItem(PACKAGE_CACHE_KEY);
  if (!cached) return new Set();
  try {
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed)) {
      return new Set(parsed as string[]);
    }
    return new Set();
  } catch {
    return new Set();
  }
}

/** Saves the given package names to IndexedDB/localStorage cache. */
function saveCachedPackageNames(names: Set<string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PACKAGE_CACHE_KEY, JSON.stringify(Array.from(names)));
}

/** Default runtime loader */
export async function defaultRuntimeLoader(): Promise<PyodideRuntime> {
  if (typeof window === "undefined")
    throw new Error(
      "Pyodide is available only in the browser. What happened: this function was called from a server-side context. How to fix: ensure Pyodide is only initialized in browser components.",
    );

  // Check if window.loadPyodide exists (already loaded)
  const pyodideWindow = window as PyodideWindow;
  if (pyodideWindow.loadPyodide) {
    return pyodideWindow.loadPyodide();
  }

  // Load Pyodide
  const indexURL = publicEnv.NEXT_PUBLIC_PYODIDE_URL || DEFAULT_PYODIDE_URL;
  const script = document.createElement("script");
  script.src = `${indexURL.replace(/\/$/, "")}/pyodide.js`;
  script.async = true;
  await new Promise<void>((resolve, reject) => {
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Pyodide assets could not be downloaded."));
    document.head.appendChild(script);
  });

  // The script tag above just defined the global — an assertion (not an
  // annotation) so TS does not carry the earlier guard's narrowing here.
  const loader = pyodideWindow.loadPyodide as PyodideLoader | undefined;
  if (!loader)
    throw new Error(
      "Pyodide loaded without its browser loader. What happened: the Pyodide runtime is missing its loadPyodide function. How to fix: check that the Pyodide CDN script loaded correctly, or refresh the page.",
    );
  return loader();
}

/** Load a package with IndexedDB caching */
export async function loadPackageWithCache(
  runtime: PyodideRuntime,
  packages: string[],
  options?: { reload?: boolean },
): Promise<void> {
  const { reload = false } = options || {};

  // Determine which packages need loading (not already cached)
  const cachedPackages = reload ? new Set<string>() : getCachedPackageNames();
  const packagesToLoad = packages.filter((pkg: string) => !cachedPackages.has(pkg));

  if (packagesToLoad.length > 0) {
    await runtime.loadPackage(packagesToLoad);

    // Cache the newly loaded packages
    const allCached = new Set(cachedPackages);
    packagesToLoad.forEach((pkg: string) => allCached.add(pkg));
    saveCachedPackageNames(allCached);
  }
}

/** Load core packages with caching */
export async function loadCorePackagesWithCache(runtime: PyodideRuntime, packages?: string[]): Promise<void> {
  const pkgs = packages || CORE_PYODIDE_PACKAGES;
  await loadPackageWithCache(runtime, pkgs);
}

/** Create a Pyodide kernel with package caching */
export function createPyodideKernel(
  ctx: DslContext,
  loadRuntime: () => Promise<PyodideRuntime> = defaultRuntimeLoader,
  additionalDatasets: PyodideDataset[] = [],
): PyodideKernel {
  let runtime: PyodideRuntime | undefined;
  let stdout = "";
  let stderr = "";

  const readyPromise = (async (): Promise<void> => {
    runtime = await loadRuntime();
    runtime.setStdout?.({ batched: (value: string) => (stdout += value) });
    runtime.setStderr?.({ batched: (value: string) => (stderr += value) });
    await loadCorePackagesWithCache(runtime);
    runtime.globals.set("__aerolexa_dataset_json", JSON.stringify(ctx.rows));
    runtime.globals.set("__aerolexa_columns_json", JSON.stringify(ctx.columns.map((column) => column.name)));
    for (const dataset of additionalDatasets) {
      runtime.globals.set(`__aerolexa_${tableAlias(dataset.name)}_json`, JSON.stringify(dataset.rows));
    }
    const extraFrames = additionalDatasets
      .map(
        (dataset) =>
          `df_${tableAlias(dataset.name)} = pd.DataFrame(json.loads(__aerolexa_${tableAlias(dataset.name)}_json), columns=json.loads(__aerolexa_${tableAlias(dataset.name)}_columns))`,
      )
      .join("\n");
    await runtime.runPythonAsync(`
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
df = pd.DataFrame(json.loads(__aerolexa_dataset_json), columns=json.loads(__aerolexa_columns_json))
${extraFrames}
`);
  })();

  const ready: PyodideKernel["ready"] = readyPromise;

  const run: PyodideKernel["run"] = async (code: string): Promise<NotebookCellOutput> => {
    if (!code.trim())
      return { type: "error", message: "The cell is empty. Add Python code and run it.", kernel: "pyodide" };
    try {
      await readyPromise;
      stdout = "";
      stderr = "";
      const source = JSON.stringify(code);
      const result = await runtime!.runPythonAsync(`
import ast
__aerolexa_result__ = None
__aerolexa_image__ = None
__aerolexa_tree = ast.parse(${source})
if __aerolexa_tree.body and isinstance(__aerolexa_tree.body[-1], ast.Expr):
    __aerolexa_prefix = ast.Module(body=__aerolexa_tree.body[:-1], type_ignores=[])
    exec(compile(__aerolexa_prefix, "<cell>", "exec"), globals(), globals())
    __aerolexa_result__ = eval(compile(ast.Expression(__aerolexa_tree.body[-1].value), "<cell>", "eval"), globals(), globals())
else:
    exec(compile(__aerolexa_tree, "<cell>", "exec"), globals(), globals())
if plt.get_fignums():
    import base64
    import io
    __aerolexa_buffer = io.BytesIO()
    plt.gcf().savefig(__aerolexa_buffer, format="png", bbox_inches="tight")
    __aerolexa_image__ = base64.b64encode(__aerolexa_buffer.getvalue()).decode("ascii")
    plt.close("all")
`);
      // Type-safe image check - imageObj can be null/undefined
      const imageObj = runtime!.globals.get("__aerolexa_image__") as PyodideProxy | string | null | undefined;
      const image =
        imageObj !== null && imageObj !== undefined
          ? typeof imageObj === "string"
            ? imageObj
            : typeof imageObj === "object" && "toJs" in imageObj
              ? String(imageObj.toJs())
              : String(imageObj)
          : "";
      if (image) return { type: "image", image: { mimeType: "image/png", data: image }, kernel: "pyodide" };
      // Type-safe result check
      const resultObj = runtime!.globals.get("__aerolexa_result__") as PyodideProxy | string | null | undefined;
      const value =
        resultObj !== null && resultObj !== undefined
          ? typeof resultObj === "string"
            ? resultObj
            : typeof resultObj === "object" && "toJs" in resultObj
              ? String(resultObj.toJs())
              : String(resultObj)
          : String(result);
      if (stderr)
        return {
          type: "error",
          message: `${stderr.trim()} How to fix: correct the Python code and run the cell again.`,
          kernel: "pyodide",
        };
      return {
        type: "text",
        text: [stdout.trim(), value].filter(Boolean).join("\n") || "Executed successfully.",
        kernel: "pyodide",
      };
    } catch (error) {
      return {
        type: "error",
        message: `Python execution failed: ${error instanceof Error ? error.message : "unknown error"}. How to fix: check the package, data, and syntax, then run the cell again.`,
        kernel: "pyodide",
      };
    }
  };

  return { ready, run };
}

function tableAlias(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9_ ]/g, " ")
    .trim()
    .split(/\s+/)
    .join("_")
    .toLowerCase();
  return clean || "dataset";
}
