/**
 * Scene performance budgets — draw-call and heap limits per tier.
 *
 * These are the "honest capability" gates from the master plan (§7.3).
 * Every scene must stay within these budgets; the e2e suite asserts them.
 */

export interface DrawCallBudget {
  maxDrawCalls: number;
  maxHeapMB: number;
}

export const DRAW_CALL_BUDGETS: Record<"studio" | "depth" | "flat", DrawCallBudget> = {
  studio: { maxDrawCalls: 100, maxHeapMB: 250 },
  depth: { maxDrawCalls: 40, maxHeapMB: 150 },
  flat: { maxDrawCalls: 0, maxHeapMB: 0 },
};

export function assertDrawCallBudget(
  tier: "studio" | "depth" | "flat",
  actualDrawCalls: number,
  actualHeapMB: number,
): { pass: boolean; message: string } {
  const budget = DRAW_CALL_BUDGETS[tier];
  const drawCallOk = actualDrawCalls <= budget.maxDrawCalls;
  const heapOk = actualHeapMB <= budget.maxHeapMB;

  if (!drawCallOk && !heapOk) {
    return {
      pass: false,
      message: `Tier ${tier}: draw calls ${actualDrawCalls} > ${budget.maxDrawCalls} AND heap ${actualHeapMB}MB > ${budget.maxHeapMB}MB`,
    };
  }
  if (!drawCallOk) {
    return {
      pass: false,
      message: `Tier ${tier}: draw calls ${actualDrawCalls} > ${budget.maxDrawCalls}`,
    };
  }
  if (!heapOk) {
    return {
      pass: false,
      message: `Tier ${tier}: heap ${actualHeapMB}MB > ${budget.maxHeapMB}MB`,
    };
  }
  return {
    pass: true,
    message: `Tier ${tier}: draw calls ${actualDrawCalls}/${budget.maxDrawCalls}, heap ${actualHeapMB}MB/${budget.maxHeapMB}MB`,
  };
}

/**
 * Extract draw call count from a three.js renderer info object.
 * In R3F, this is available via `gl.info.render.calls` after a frame.
 */
export function getDrawCallCount(renderer: { info?: { render?: { calls?: number } } }): number {
  return renderer.info?.render?.calls ?? 0;
}

/**
 * Estimate JS heap size in MB using performance.memory (Chrome/Edge) or
 * performance.measureUserAgentSpecificMemory (experimental).
 */
export async function getHeapSizeMB(): Promise<number> {
  const perf = globalThis.performance as Performance & {
    memory?: { usedJSHeapSize: number };
    measureUserAgentSpecificMemory?: () => Promise<{
      bytes: number;
      breakdown: unknown[];
    }>;
  };

  if (perf.memory?.usedJSHeapSize) {
    return perf.memory.usedJSHeapSize / (1024 * 1024);
  }

  if (perf.measureUserAgentSpecificMemory) {
    try {
      const result = await perf.measureUserAgentSpecificMemory();
      return result.bytes / (1024 * 1024);
    } catch {
      // Fall through to 0
    }
  }

  return 0;
}

/**
 * Sample draw calls and heap over a duration, returning the max observed.
 */
export async function samplePerformanceMetrics(
  renderer: { info?: { render?: { calls?: number } } },
  durationMs: number,
): Promise<{ maxDrawCalls: number; maxHeapMB: number }> {
  let maxDrawCalls = 0;
  let maxHeapMB = 0;
  const start = Date.now();

  return new Promise((resolve) => {
    const sample = async () => {
      const drawCalls = getDrawCallCount(renderer);
      const heapMB = await getHeapSizeMB();
      maxDrawCalls = Math.max(maxDrawCalls, drawCalls);
      maxHeapMB = Math.max(maxHeapMB, heapMB);

      if (Date.now() - start < durationMs) {
        requestAnimationFrame(sample);
      } else {
        resolve({ maxDrawCalls, maxHeapMB });
      }
    };
    requestAnimationFrame(sample);
  });
}
