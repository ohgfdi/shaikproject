/**
 * Scene performance budgets (S2.3) — unit gate for the draw-call/heap limits
 * the e2e specs assert (lib/scene/performance-budgets.ts).
 *
 * The budgets are the plan's honest-capability contract: studio <100 draw
 * calls, depth <40, heap <250 MB studio / <150 MB depth. This suite pins the
 * constants themselves and the assert/sample helpers, so a silent budget
 * relaxation fails a unit test before it ever reaches CI.
 */
import {
  assertDrawCallBudget,
  DRAW_CALL_BUDGETS,
  getDrawCallCount,
  getHeapSizeMB,
} from "@/lib/scene/performance-budgets";

describe("DRAW_CALL_BUDGETS — the plan's §7.3 constants", () => {
  it("pins studio at <100 draw calls and <250 MB heap", () => {
    expect(DRAW_CALL_BUDGETS.studio).toEqual({ maxDrawCalls: 100, maxHeapMB: 250 });
  });

  it("pins depth at <40 draw calls and <150 MB heap", () => {
    expect(DRAW_CALL_BUDGETS.depth).toEqual({ maxDrawCalls: 40, maxHeapMB: 150 });
  });

  it("pins flat at zero — no canvas, no cost", () => {
    expect(DRAW_CALL_BUDGETS.flat).toEqual({ maxDrawCalls: 0, maxHeapMB: 0 });
  });
});

describe("assertDrawCallBudget", () => {
  it("passes inside both budgets and reports the headroom", () => {
    const r = assertDrawCallBudget("studio", 80, 200);
    expect(r.pass).toBe(true);
    expect(r.message).toContain("80/100");
  });

  it("passes exactly at the boundary (budgets are ≤, not <)", () => {
    expect(assertDrawCallBudget("depth", 40, 150).pass).toBe(true);
    expect(assertDrawCallBudget("studio", 100, 250).pass).toBe(true);
  });

  it("fails on draw-call breach alone", () => {
    const r = assertDrawCallBudget("depth", 41, 100);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("draw calls 41 > 40");
  });

  it("fails on heap breach alone", () => {
    const r = assertDrawCallBudget("studio", 50, 251);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("251MB > 250MB");
  });

  it("fails with a combined message when both are breached", () => {
    const r = assertDrawCallBudget("depth", 41, 151);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("AND");
  });

  it("flat tier fails on any measured draw call or heap", () => {
    expect(assertDrawCallBudget("flat", 1, 0).pass).toBe(false);
    expect(assertDrawCallBudget("flat", 0, 0.1).pass).toBe(false);
    expect(assertDrawCallBudget("flat", 0, 0).pass).toBe(true);
  });
});

describe("getDrawCallCount", () => {
  it("reads gl.info.render.calls from a three.js renderer", () => {
    expect(getDrawCallCount({ info: { render: { calls: 37 } } })).toBe(37);
  });

  it("fails closed to 0 when renderer info is absent", () => {
    expect(getDrawCallCount({})).toBe(0);
    expect(getDrawCallCount({ info: {} })).toBe(0);
    expect(getDrawCallCount({ info: { render: {} } })).toBe(0);
  });
});

describe("getHeapSizeMB — node/jsdom contract", () => {
  it("fails closed to 0 outside a browser with performance.memory", async () => {
    // jsdom/node has neither performance.memory nor
    // measureUserAgentSpecificMemory — the honest "unmeasured" 0.
    await expect(getHeapSizeMB()).resolves.toBe(0);
  });

  it("converts bytes to MB when performance.memory exists", async () => {
    const perf = globalThis.performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    const original = perf.memory;
    Object.defineProperty(perf, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 157_286_400 }, // 150 MB
    });
    try {
      await expect(getHeapSizeMB()).resolves.toBeCloseTo(150);
    } finally {
      if (original === undefined) delete (perf as { memory?: unknown }).memory;
      else perf.memory = original;
    }
  });
});
