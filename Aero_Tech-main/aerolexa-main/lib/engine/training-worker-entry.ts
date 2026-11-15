/**
 * Worker entry for thread-offloaded ML training (bundled together with the
 * engine by lib/engine/training-worker.ts via esbuild — this file + the
 * engine become ONE standalone `data/workers/ml-training.worker.cjs`).
 *
 * Protocol (structured-clone JSON over postMessage):
 *   ← { type: "fit", id, source, req }
 *   → { type: "progress", id, progress }   (0..n times per fit)
 *   → { type: "result", id, result }  |  { type: "error", id, message }
 *   ← { type: "dispose" }
 *
 * The engine is a PURE function of (source, request) — no DB, no env — so the
 * worker needs nothing but the bundle itself, and results are byte-identical
 * to inline fits (pinned by __tests__/unit/training-progress.test.ts).
 */
import { parentPort } from "node:worker_threads";

import { trainWithCv, type MlSource, type MlTrainRequest, type MlTrainResult } from "@/lib/engine/ml-training";
import type { TrainingProgress } from "@/lib/engine/training-worker";

interface FitMessage {
  type: "fit";
  id: number;
  source: MlSource;
  req: MlTrainRequest;
}
type Incoming = FitMessage | { type: "dispose" };

if (!parentPort) {
  throw new Error("ml-training.worker must run inside a worker_threads Worker.");
}

const port = parentPort;

port.on("message", (msg: Incoming) => {
  if (msg.type === "dispose") {
    process.exit(0);
  }
  if (msg.type !== "fit") return;
  const { id, source, req } = msg;
  try {
    const result = trainWithCv(source, req, (progress: TrainingProgress) => {
      port.postMessage({ type: "progress", id, progress });
    });
    port.postMessage({ type: "result", id, result: result as MlTrainResult });
  } catch (err) {
    port.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
