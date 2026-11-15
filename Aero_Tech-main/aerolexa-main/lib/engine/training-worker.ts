/**
 * Worker-thread ML training.
 *
 * Long training runs (histogram boosting on large datasets, 200-epoch MLPs)
 * are CPU-bound for seconds at a time. On the request thread that blocks the
 * event loop for EVERY user; here the same pure engine runs inside a
 * worker_threads Worker, so the server stays responsive while it fits.
 *
 * Architecture:
 *  - At first use the engine module is bundled to a standalone CJS file with
 *    the locally-installed esbuild (no dev build step — the bundle
 *    regenerates automatically when the engine source is newer).
 *  - A single long-lived Worker (`unref`'d so it never blocks process exit)
 *    answers { fit } requests with the full MlTrainResult.
 *  - Progress: `trainWithCv` accepts an `onProgress` callback; inline calls
 *    invoke it directly, the worker forwards { progress } messages. A run
 *    that reports nothing within `timeoutMs` (default 120s) fails loudly
 *    instead of hanging silently — retrying is safe (pure function).
 *  - Equivalence: the worker executes the SAME pure function on the SAME
 *    inputs, so results are byte-identical to inline fits (oracle-pinned).
 *  - Inline fallback: when esbuild or worker_threads are unavailable
 *    (restricted sandboxes), `runTraining` runs on the calling thread — the
 *    historical behaviour.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { Worker as WorkerThread } from "node:worker_threads";

import type { MlSource, MlTrainRequest, MlTrainResult } from "@/lib/engine/ml-training";

/** Progress reported during a fit (completed/total units of one phase). */
export interface TrainingProgress {
  phase: "cv" | "refit" | "importance";
  done: number;
  total: number;
}

export type OnProgress = (p: TrainingProgress) => void;

/** The engine handle both paths expose. */
export interface TrainEngine {
  trainWithCv(source: MlSource, req: MlTrainRequest, onProgress?: OnProgress): Promise<MlTrainResult>;
  dispose(): Promise<void>;
}

type WorkerRequest = { type: "fit"; id: number; source: MlSource; req: MlTrainRequest } | { type: "dispose" };

type WorkerResponse =
  | { type: "result"; id: number; result: MlTrainResult }
  | { type: "progress"; id: number; progress: TrainingProgress }
  | { type: "error"; id: number; message: string };

/**
 * Bundle the engine once per process (refreshed when the source is newer).
 * Returns the bundle path, or null when esbuild/worker threads are
 * unavailable (the caller falls back to inline training).
 */
async function bundleEngine(): Promise<string | null> {
  const root = process.cwd();
  // The ENTRY is the protocol shim; the engine is bundled into it.
  const engineTs = path.join(root, "lib", "engine", "training-worker-entry.ts");
  if (!existsSync(engineTs)) return null;
  const outDir = path.join(root, "data", "workers");
  const outFile = path.join(outDir, "ml-training.worker.cjs");
  try {
    if (existsSync(outFile) && statSync(outFile).mtimeMs >= statSync(engineTs).mtimeMs) return outFile;
  } catch {
    /* stat races are harmless — rebuild */
  }
  try {
    // Externalized in next.config.mjs, so this stays a runtime import instead
    // of webpack trying to inline a native binary.
    const esbuild = await import("esbuild");
    mkdirSync(outDir, { recursive: true });
    esbuild.buildSync({
      entryPoints: [engineTs],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile: outFile,
      logLevel: "silent",
    });
    return existsSync(outFile) ? outFile : null;
  } catch {
    return null;
  }
}

/** Whether worker threads can spawn in this runtime. */
function workersAvailable(): boolean {
  try {
    // Under jest, esbuild.buildSync's service process deadlocks with jest's
    // own worker pool — the inline path runs there (the REAL thread mechanics
    // are verified by `npm run verify:worker`, a plain-node script CI runs).
    return (
      process.env.NEXT_RUNTIME !== "edge" && typeof process.versions.node === "string" && !process.env.JEST_WORKER_ID
    );
  } catch {
    return false;
  }
}

/**
 * Inline engine: the historical path — runs trainWithCv on the calling
 * thread. Used when workers are unavailable and by the equivalence oracles.
 */
export function createInlineEngine(): TrainEngine {
  return {
    async trainWithCv(source, req, onProgress) {
      const mod = await import("@/lib/engine/ml-training");
      return mod.trainWithCv(source, req, onProgress);
    },
    async dispose() {
      /* nothing to release */
    },
  };
}

interface Pending {
  resolve: (r: MlTrainResult) => void;
  reject: (e: Error) => void;
  onProgress?: OnProgress;
  timer: NodeJS.Timeout;
}

const pending = new Map<number, Pending>();
let worker: import("node:worker_threads").Worker | null = null;

function ensureWorker(bundlePath: string): import("node:worker_threads").Worker {
  if (worker) return worker;
  worker = new WorkerThread(bundlePath);
  worker.unref();
  worker.on("message", (raw: WorkerResponse) => {
    const p = pending.get(raw.id);
    if (!p) return;
    if (raw.type === "progress") {
      p.onProgress?.(raw.progress);
      return;
    }
    clearTimeout(p.timer);
    pending.delete(raw.id);
    if (raw.type === "result") p.resolve(raw.result);
    else p.reject(new Error(raw.message));
  });
  worker.on("error", () => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Training worker crashed — retry the fit."));
    }
    pending.clear();
    worker = null;
  });
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
}

let nextId = 1;

/**
 * Run training on the best available engine: a worker thread when possible,
 * the calling thread otherwise. Results are byte-identical either way — the
 * same pure function runs on the same inputs.
 */
export async function runTraining(opts: {
  source: MlSource;
  request: MlTrainRequest;
  onProgress?: OnProgress;
  forceInline?: boolean;
  timeoutMs?: number;
}): Promise<MlTrainResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const inline = (): Promise<MlTrainResult> =>
    createInlineEngine().trainWithCv(opts.source, opts.request, opts.onProgress);

  const bundle = workersAvailable() && !opts.forceInline ? await bundleEngine() : null;
  if (!bundle) return inline();

  const w = ensureWorker(bundle);
  const id = nextId++;
  return new Promise<MlTrainResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `Training exceeded ${Math.round(timeoutMs / 1000)}s without progress — try fewer folds/epochs or a smaller sample.`,
        ),
      );
    }, timeoutMs);
    pending.set(id, { resolve, reject, onProgress: opts.onProgress, timer });
    w.postMessage({ type: "fit", id, source: opts.source, req: opts.request } satisfies WorkerRequest);
  });
}

/** Shut the shared worker down (tests / server shutdown). */
export async function disposeTrainingWorker(): Promise<void> {
  if (worker) {
    worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
    await worker.terminate().catch(() => undefined);
    worker = null;
  }
  pending.clear();
}
