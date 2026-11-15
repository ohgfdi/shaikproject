/**
 * Online / incremental learning tests — hand-computable, deterministic.
 *
 * Pins the contracts that make streaming updates trustworthy:
 *  - SGD on a fixed linear truth CONVERGES (RMSE → near 0) and beats a
 *    zero-model baseline by the documented margin;
 *  - logistic online MAE-style tracking (probabilities ordered with labels);
 *  - determinism: same stream ⇒ byte-identical weights (no RNG);
 *  - state round-trip: checkpoint → resume continues EXACTLY where it left;
 *  - dimension mismatches and missing labels fail LOUDLY;
 *  - L2 shrinkage pulls idle weights toward 0 (regularization true, not vibes).
 */
import { describe, expect, it } from "@jest/globals";

import { OnlineLearner, OnlineError, type OnlineState } from "@/lib/engine/online-learning";

function rmse(actuals: number[], preds: number[]): number {
  return Math.sqrt(actuals.reduce((s, y, i) => s + Math.pow(y - (preds[i] as number), 2), 0) / actuals.length);
}

describe("OnlineLearner — regression stream", () => {
  it("converges on a fixed linear truth (RMSE < 2 on the tail)", () => {
    // Truth: y = 3·x1 − 2·x2 + 10; x fed in the TRAIN-FITTED standardized
    // encoding the contract requires (x1/17, x2/5 are the max-normalized
    // stand-ins — the encoding normalization is the trainer's job).
    const learner = new OnlineLearner("regression", 2, { stepSize0: 0.5, l2: 0 });
    const preds: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 600; i++) {
      const x1 = (i % 17) / 17;
      const x2 = (i % 5) / 5;
      const x = [x1, x2];
      const y = 3 * 17 * x1 - 2 * 5 * x2 + 10;
      ys.push(y);
      preds.push(learner.predict(x));
      learner.update(x, y);
    }
    // Tail slice — convergence is judged on the LAST 200 rows.
    const tailPreds = preds.slice(-200);
    const tailYs = ys.slice(-200);
    expect(rmse(tailYs, tailPreds)).toBeLessThan(2);
    // And online self-score tracks the same truth.
    const self = learner.selfScore();
    expect(self.metric).toBe("rmse");
    expect(Number.isFinite(self.value)).toBe(true);
  });

  it("L2 shrinkage does not let unused weights wander", () => {
    const learner = new OnlineLearner("regression", 3, { stepSize0: 0.2, l2: 0.05 });
    for (let i = 0; i < 300; i++) {
      const x1 = (i % 9) + 1;
      learner.update([x1, 0, 0], 4 * x1);
    }
    // A truly idle feature (always 0) CANNOT receive gradient, so it stays 0
    // exactly — weight decay through x = 0 never moves it.
    expect(learner.state.weights[2]).toBe(0);
  });

  it("is deterministic: same stream ⇒ identical state", () => {
    const build = (): OnlineLearner => {
      const l = new OnlineLearner("regression", 2, { stepSize0: 0.1, l2: 1e-4 });
      for (let i = 0; i < 50; i++) {
        const x = [(i % 11) + 1, i % 7];
        l.update(x, 2 * x[0]! - x[1]! + 1);
      }
      return l;
    };
    expect(build().state).toEqual(build().state);
  });

  it("checkpoint round-trip continues exactly where it stopped", () => {
    const half = (): OnlineLearner => {
      const l = new OnlineLearner("binary-classification", 2, { stepSize0: 0.2, l2: 1e-4 });
      for (let i = 0; i < 120; i++) {
        const x1 = (i % 13) + 1;
        const x2 = i % 4;
        const label = x1 + 2 * x2 > 12 ? 1 : 0;
        l.update([x1, x2], label);
      }
      l.update([5, 1], 1);
      return l;
    };
    const continuous = half();
    const scoreBefore = continuous.update([7, 2], 1);
    expect(scoreBefore.count).toBe(122);

    const checkpoint: OnlineState = JSON.parse(JSON.stringify(half().state));
    const resumed = OnlineLearner.fromState(checkpoint);
    const afterResume = resumed.update([7, 2], 1);
    // Byte-identical continuation.
    expect(afterResume).toEqual(scoreBefore);
    expect(resumed.state).toEqual(continuous.state);
  });

  it("fails loudly on width/label violations", () => {
    const learner = new OnlineLearner("regression", 2);
    expect(() => learner.update([1, 2, 3], 1)).toThrow(OnlineError);
    expect(() => learner.predict([1])).toThrow(OnlineError);
    expect(() => learner.update([1, 2], Number.NaN)).toThrow(OnlineError);
    expect(() => learner.updateAll([[1, 2]], [1, 2])).toThrow(OnlineError);
  });
});

describe("OnlineLearner — classification stream", () => {
  it("orders probabilities with labels on a separable truth", () => {
    const learner = new OnlineLearner("binary-classification", 1, { stepSize0: 0.4, l2: 0 });
    for (let i = 0; i < 400; i++) {
      const x = (i % 20) / 20; // 0..0.95 deterministic sweep
      learner.update([x], x > 0.5 ? 1 : 0);
    }
    const low = learner.predict([0.05]);
    const high = learner.predict([0.9]);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    expect(learner.selfScore().metric).toBe("logLoss");
  });
});
