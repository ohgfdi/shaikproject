/**
 * Oracle tests for thread-offloaded training:
 *
 *  - the PROGRESS contract: a full trainWithCv run emits cv → refit →
 *    importance in order, every fold reports, totals are exact, and the
 *    final progress carries the last importance feature (the callback is
 *    invoked identically inline and inside the training worker — the same
 *    pure engine function owns it);
 *  - the EQUIVALENCE contract: `runTraining` (inline under jest; worker
 *    thread in production and in `npm run verify:worker`) returns results
 *    byte-identical to a direct trainWithCv call — same folds, same
 *    importance, same artifact;
 *  - progress callback absence changes nothing (default-argument purity).
 *
 * NOTE on the worker thread itself: esbuild.buildSync deadlocks under jest's
 * worker pool, so `runTraining` deliberately falls back to inline under
 * JEST_WORKER_ID. The REAL thread mechanics (bundle → spawn → progress
 * forwarding → byte-equal result) are verified outside jest by
 * `npm run verify:worker` — a plain-node script wired into CI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { trainWithCv, type MlSource, type MlTrainRequest, type TrainProgress } from "@/lib/engine/ml-training";
import { runTraining } from "@/lib/engine/training-worker";

const SRC = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

function classificationSource(): MlSource {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 60; i++) {
    const spend = i * 2;
    rows.push([spend, spend >= 50 ? "yes" : "no"]);
  }
  return {
    columns: [
      { name: "spend", type: "number" },
      { name: "label", type: "string" },
    ],
    rows,
  };
}

const REQ: MlTrainRequest = {
  task: "binary-classification",
  algorithm: "random-forest",
  targetColumn: "label",
  cvFolds: 3,
  seed: 11,
  nTrees: 8,
};

describe("training progress contract", () => {
  it("emits cv → refit → importance in order with exact totals", () => {
    const events: TrainProgress[] = [];
    trainWithCv(classificationSource(), REQ, (p) => events.push(p));
    // Phases in order, never interleaved.
    const phases = events.map((e) => e.phase);
    const firstIdx = (ph: string): number => phases.indexOf(ph as TrainProgress["phase"]);
    expect(phases[0]).toBe("cv");
    expect(firstIdx("refit")).toBeGreaterThan(firstIdx("cv"));
    expect(firstIdx("importance")).toBeGreaterThan(firstIdx("refit"));
    // Every fold reports exactly once, monotonically.
    const cv = events.filter((e) => e.phase === "cv");
    expect(cv.map((e) => e.done)).toEqual([1, 2, 3]);
    expect(cv.every((e) => e.total === 3)).toBe(true);
    // Refit reports start and completion.
    expect(events.filter((e) => e.phase === "refit").map((e) => e.done)).toEqual([0, 1]);
    // Importance: one event per design column (the fixture has 1 numeric
    // feature → featureNames = ["spend"]), totals exact.
    const imp = events.filter((e) => e.phase === "importance");
    expect(imp.map((e) => e.done)).toEqual([1]);
    expect(imp.every((e) => e.total === 1)).toBe(true);
  });

  it("progress-free call is unchanged (no callback ⇒ identical result)", () => {
    const a = trainWithCv(classificationSource(), REQ);
    const b = trainWithCv(classificationSource(), REQ, () => undefined);
    expect(a.cv).toEqual(b.cv);
    expect(a.importance).toEqual(b.importance);
    expect(a.artifact).toEqual(b.artifact);
  });
});

describe("runTraining — equivalence contract", () => {
  it("returns results byte-identical to the direct engine call", async () => {
    const direct = trainWithCv(classificationSource(), REQ);
    const events: TrainProgress[] = [];
    const viaRun = await runTraining({
      source: classificationSource(),
      request: REQ,
      onProgress: (p) => events.push(p),
      timeoutMs: 60_000,
    });
    expect(viaRun.cv).toEqual(direct.cv);
    expect(viaRun.importance).toEqual(direct.importance);
    expect(viaRun.artifact).toEqual(direct.artifact);
    // Progress flows through runTraining regardless of engine path.
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.phase).toBe("cv");
  });

  it("propagates engine errors with their message", async () => {
    const tiny: MlSource = {
      columns: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      rows: Array.from({ length: 10 }, (_, i) => [i, i]),
    };
    await expect(
      runTraining({ source: tiny, request: { ...REQ, targetColumn: "y", task: "regression" }, timeoutMs: 30_000 }),
    ).rejects.toThrow("at least 12 rows");
  });
});

describe("client wiring contract (models tab ⇄ SSE ⇄ hub)", () => {
  const tab = SRC("components/models/models-tab.tsx");

  it("client generates a runId and subscribes BEFORE the POST (no missed events)", () => {
    expect(tab.includes("run-${Date.now()")).toBe(true);
    expect(tab.indexOf("new EventSource")).toBeGreaterThan(-1);
    expect(tab.indexOf("new EventSource")).toBeLessThan(tab.indexOf('/api/training",'));
  });

  it("closes the stream on done/error/unmount (no leaked subscriptions)", () => {
    expect(tab).toContain('source.addEventListener("done", stop)');
    expect(tab).toContain('source.addEventListener("error", stop)');
    expect(tab).toContain("progressSourceRef.current?.close()");
  });

  it("SSE route waits for a late-registered run instead of fatal 404", () => {
    const route = SRC("app/api/training/progress/route.ts");
    expect(route).toContain("deadline");
    expect(route).toContain("NOT_FOUND"); // only after the wait window
  });
});
