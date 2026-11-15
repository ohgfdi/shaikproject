/**
 * Server-side Python kernel manager.
 *
 * Owns the single long-lived worker thread that runs the real Pyodide
 * distribution (CPython 3.14 on wasm32, wheels for numpy/pandas/scipy/
 * scikit-learn/statsmodels/matplotlib). Requests are queued one at a time —
 * one Python namespace per worker — and every request carries a hard timeout:
 * when it fires the worker is terminated and respawned, so a runaway
 * `while True:` costs one cold start, never a wedged server.
 *
 * Environment gate: PYODIDE_SERVER_ENABLED (default off). When the engine
 * cannot start the caller receives an explicit `PYTHON_KERNEL_UNAVAILABLE`
 * ApiError — never a silent downgrade to weaker results. Server-side Pyodide
 * is opt-in because first boot downloads/loads the wasm + stdlib (~2.5 s warm
 * machine, more on cold CI) and operators should choose when that cost lands.
 *
 * Outputs are labelled `pyodide-server` end to end.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";

import { ApiError } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";
import type { NotebookCellOutput } from "@/lib/types";

export const PYTHON_KERNEL_NOTE =
  "Server-side Python: real CPython (Pyodide wasm) in an isolated worker thread — no filesystem or network access from cells.";

/** Hard per-cell wall clock. A timed-out worker is killed and respawned. */
const CELL_TIMEOUT_MS = 20_000;
/** How long a respawned worker may take to become ready. */
const BOOT_TIMEOUT_MS = 60_000;

const KERNEL_BOOT_TIMEOUT_MESSAGE = `The Python kernel did not become ready within ${Math.round(BOOT_TIMEOUT_MS / 1000)} seconds. What happened: the Pyodide runtime (wasm + stdlib) could not load. How to fix: confirm the pyodide package is installed (\`npm install\`) and that the machine has network access on first boot for package wheels, then retry.`;

interface RunPayload {
  code: string;
  dataset?: { columns: { name: string }[]; rows: (string | number | boolean | null)[][] };
  extras?: Record<string, { columns: { name: string }[]; rows: (string | number | boolean | null)[][] }>;
}

type WorkerResult =
  { ok: true; type: "text"; text: string } | { ok: true; type: "image"; data: string } | { ok: false; error: string };

interface QueuedRequest {
  payload: RunPayload;
  resolve: (value: WorkerResult) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker: NodeWorker | null = null;
let workerReady = false;
let booting = false;
let bootPromise: Promise<void> | null = null;
/** Cells handed to the worker whose result has not come back yet. */
let inFlight = 0;
let queue: QueuedRequest[] = [];
/** Requests that arrived while the engine was unavailable — rejected explicitly. */
let nextRequestId = 0;
const pending = new Map<number, (value: WorkerResult) => void>();

function resolvePyodideDir(): string {
  const appDir = process.cwd();
  const candidates = [
    path.join(appDir, "node_modules", "pyodide"),
    path.join(appDir, "Ledgerly-main", "node_modules", "pyodide"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "pyodide-lock.json"))) return candidate;
  }
  // Upward search (mirrors the DuckDB resolver for monorepo layouts).
  let dir = path.resolve(appDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidate = path.join(dir, "node_modules", "pyodide");
    if (existsSync(path.join(candidate, "pyodide-lock.json"))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("The pyodide package is not installed. How to fix: run `npm install`.");
}

function spawnWorker(): Promise<void> {
  if (booting && bootPromise) return bootPromise;
  booting = true;
  workerReady = false;

  bootPromise = new Promise<void>((resolve, reject) => {
    try {
      const pyodideDir = resolvePyodideDir();
      const w = new NodeWorker(path.join(__dirname, "worker-bootstrap.cjs"), {
        workerData: {
          indexURL: pyodideDir + path.sep,
          lockFileURL: path.join(pyodideDir, "pyodide-lock.json"),
          pyodideNodeModules: path.dirname(pyodideDir),
        },
        // Large result strings (base64 PNGs, big tables) cross here.
        resourceLimits: { maxOldGenerationSizeMb: 2048 },
      });
      worker = w;
      const bootTimer = setTimeout(() => {
        terminateWorker();
        booting = false;
        bootPromise = null;
        reject(new ApiError(503, "PYTHON_KERNEL_UNAVAILABLE", KERNEL_BOOT_TIMEOUT_MESSAGE));
      }, BOOT_TIMEOUT_MS);

      w.on("message", (msg: { type: string; id?: number; result?: WorkerResult }) => {
        // Stale-worker guard: terminate() is asynchronous, so a killed worker's
        // events can arrive AFTER a successor was spawned. Only the live
        // worker may touch shared state.
        if (worker !== w) return;
        if (msg.type === "ready") {
          workerReady = true;
          booting = false;
          clearTimeout(bootTimer);
          resolve();
          return;
        }
        if (msg.type === "result" && typeof msg.id === "number" && msg.result) {
          const resolver = pending.get(msg.id);
          pending.delete(msg.id);
          inFlight = Math.max(0, inFlight - 1);
          resolver?.(msg.result);
          drain();
        }
      });
      w.on("error", (err) => {
        clearTimeout(bootTimer);
        if (worker !== w) return;
        const wasBooting = booting;
        failAllInFlight(`The Python kernel worker crashed: ${err.message}`);
        terminateWorker();
        booting = false;
        bootPromise = null;
        // A crash during boot must not hang callers awaiting the first request.
        if (wasBooting)
          reject(
            new ApiError(
              503,
              "PYTHON_KERNEL_UNAVAILABLE",
              `The Python kernel worker crashed during startup: ${err.message}`,
            ),
          );
      });
      w.on("exit", (code) => {
        clearTimeout(bootTimer);
        // A terminated worker's exit can land AFTER a respawn created its
        // successor; only the live worker may reset the shared lifecycle
        // state, or it would tear down a healthy engine mid-flight.
        if (worker !== w) return;
        worker = null;
        workerReady = false;
        booting = false;
        bootPromise = null;
        if (code !== 0) failAllInFlight(`The Python kernel exited unexpectedly (code ${code}).`);
      });
    } catch (err) {
      booting = false;
      bootPromise = null;
      reject(err);
    }
  });
  return bootPromise;
}
function terminateWorker() {
  if (worker) {
    const w = worker;
    // Drop the reference and the ready flag SYNCHRONOUSLY: terminate() is
    // async, and the dying worker's late exit/result events must never see a
    // usable engine. ensureReady() respawns lazily on the next request.
    worker = null;
    workerReady = false;
    w.terminate().catch(() => undefined);
  }

  workerReady = false;
}

function failAllInFlight(message: string) {
  for (const [, resolver] of pending) {
    resolver({ ok: false, error: message });
  }
  pending.clear();
  inFlight = 0;
  for (const req of queue) {
    if (req.timer) clearTimeout(req.timer);
    req.reject(new ApiError(503, "PYTHON_KERNEL_UNAVAILABLE", message));
  }
  queue = [];
}

async function ensureReady(): Promise<void> {
  if (workerReady && worker) return;
  await spawnWorker();
}

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------

function drain() {
  if (!workerReady || !worker || inFlight > 0 || queue.length === 0) return;
  const req = queue.shift()!;
  dispatch(req);
}

function dispatch(req: QueuedRequest) {
  const id = ++nextRequestId;
  if (!worker || !workerReady) {
    // Belt-and-braces: the worker died between enqueue and dispatch. Refuse
    // explicitly instead of posting into the void; the caller's next request
    // respawns the engine via ensureReady().
    req.reject(
      new ApiError(
        503,
        "PYTHON_KERNEL_UNAVAILABLE",
        "The Python kernel is restarting. How to fix: run the cell again — a fresh worker is spawned automatically on the next request.",
      ),
    );
    return;
  }
  inFlight += 1;
  const timer = setTimeout(() => {
    pending.delete(id);
    inFlight = Math.max(0, inFlight - 1);
    terminateWorker(); // the only defence against infinite loops
    req.resolve({
      ok: false,
      // ROADMAP 4.5 hardening: the message is a structured verdict the UI can
      // surface verbatim — WHAT happened, the measured cap, and the remedy —
      // never a silent hang and never a bare "terminated".
      error: PYTHON_TIMEOUT_MESSAGE,
    });
    // Respawn lazily on the next request.
    bootPromise = null;
    drain();
  }, CELL_TIMEOUT_MS);
  req.timer = timer;
  pending.set(id, (result) => {
    clearTimeout(timer);
    req.resolve(result);
  });
  worker!.postMessage({ type: "run", id, payload: req.payload });
}

/** The user-facing timeout verdict (ROADMAP 4.5) — exported for the UI and tests. */
export const PYTHON_TIMEOUT_MESSAGE = `The Python cell exceeded the ${Math.round(CELL_TIMEOUT_MS / 1000)}-second execution limit and was terminated. What happened: the cell ran longer than the server's hard per-cell wall clock (20s), so the worker was killed and a fresh one will be spawned for the next run — no results from this cell were kept. How to fix: reduce the workload (sample the dataset, lower iteration counts, avoid infinite loops) or split the work across multiple cells.`;

/** The configured per-cell wall-clock cap, in milliseconds (surfaced in UI copy). */
export const PYTHON_CELL_TIMEOUT_MS = CELL_TIMEOUT_MS;

function enqueue(payload: RunPayload): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    queue.push({ payload, resolve, reject, timer: null });
    drain();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True when operators have enabled the server-side kernel. */
export function serverPythonEnabled(): boolean {
  return serverEnv().PYODIDE_SERVER_ENABLED;
}

/**
 * Run one Python cell against the given dataset. Returns a NotebookCellOutput
 * — the same contract the DSL and browser kernels produce.
 */
export async function runServerPython(
  code: string,
  ctx: {
    datasetName: string;
    columns: { name: string; type: string }[];
    rows: (string | number | boolean | null)[][];
    totalRows: number;
  },
  extras: { name: string; columns: { name: string }[]; rows: (string | number | boolean | null)[][] }[] = [],
): Promise<NotebookCellOutput> {
  if (!serverPythonEnabled()) {
    throw new ApiError(
      503,
      "PYTHON_KERNEL_UNAVAILABLE",
      "The server-side Python kernel is disabled. How to fix: set PYODIDE_SERVER_ENABLED=true to enable real Python execution on the server (Pyodide wasm worker, no filesystem or network access).",
    );
  }
  const payload: RunPayload = {
    code,
    dataset: { columns: ctx.columns, rows: ctx.rows },
    extras: Object.fromEntries(extras.map((e) => [e.name, { columns: e.columns, rows: e.rows }])),
  };
  try {
    await ensureReady();
  } catch (err) {
    const message =
      err instanceof ApiError
        ? err.message
        : `The Python kernel could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw new ApiError(503, "PYTHON_KERNEL_UNAVAILABLE", message);
  }
  const result = await enqueue(payload);
  if (!result.ok) {
    return { type: "error", message: result.error, kernel: "pyodide-server" };
  }
  if (result.type === "image") {
    return {
      type: "image",
      image: { mimeType: "image/png", data: result.data },
      kernel: "pyodide-server",
    };
  }
  return { type: "text", text: result.text, kernel: "pyodide-server" };
}

/** Test/bootstrap hook: boots the engine and reports boot time. */
export async function ensureServerPythonReady(): Promise<number> {
  const started = Date.now();
  await ensureReady();
  return Date.now() - started;
}

/** Shut the engine down (tests, server shutdown). */
export async function disposeServerPython(): Promise<void> {
  failAllInFlight("The Python kernel was shut down.");
  terminateWorker();
  bootPromise = null;
}
