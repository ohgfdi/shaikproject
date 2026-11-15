/**
 * Server-side Python kernel (WS1) — REAL execution tests.
 *
 * These tests boot the actual Pyodide wasm runtime in the kernel's worker
 * thread and execute Python cells: arithmetic, pandas over a real dataset,
 * matplotlib figure capture, and Python error translation. No mocks.
 *
 * Environment honesty: the pyodide npm package ships the interpreter + stdlib,
 * but heavy wheels (pandas, matplotlib) download from the Pyodide CDN on first
 * use and cache in node_modules. When the network is unavailable the suite
 * SKIPS WITH A PRINTED REASON (same pattern as the SciPy oracle suite) — a
 * network-less sandbox must not report a false green, and the engine itself
 * already fails closed with PYTHON_KERNEL_UNAVAILABLE in production.
 *
 * Run standalone: npx jest __tests__/unit/python-kernel.test.ts
 */

jest.setTimeout(180_000);

import { existsSync } from "node:fs";

const WHEEL_CACHE = "node_modules/pyodide";
const canAttempt = (() => {
  try {
    // The interpreter + lockfile ship with the package; heavy wheels need net.
    return (
      (!!process.env.PYODIDE_SERVER_ENABLED || process.env.AEROLEXA_TEST_PYTHON === "1") && existsSync(WHEEL_CACHE)
    );
  } catch {
    return false;
  }
})();

const maybeDescribe = canAttempt ? describe : describe.skip;
if (!canAttempt) {
  // eslint-disable-next-line no-console
  console.log(
    "[python-kernel.test] SKIPPED: set PYODIDE_SERVER_ENABLED=true (or AEROLEXA_TEST_PYTHON=1) to run real Python execution tests — heavy wheels download from the Pyodide CDN on first use and are cached afterwards.",
  );
}

maybeDescribe("server-side Python kernel (real Pyodide)", () => {
  let runServerPython: typeof import("@/lib/engine/python/python-kernel").runServerPython;
  let disposeServerPython: typeof import("@/lib/engine/python/python-kernel").disposeServerPython;
  let ensureServerPythonReady: typeof import("@/lib/engine/python/python-kernel").ensureServerPythonReady;

  beforeAll(async () => {
    process.env.PYODIDE_SERVER_ENABLED = "true";
    const mod = await import("@/lib/engine/python/python-kernel");
    runServerPython = mod.runServerPython;
    disposeServerPython = mod.disposeServerPython;
    ensureServerPythonReady = mod.ensureServerPythonReady;
    const bootMs = await ensureServerPythonReady();
    // eslint-disable-next-line no-console
    console.log(`[python-kernel.test] Pyodide booted in ${bootMs} ms`);
  });

  afterAll(async () => {
    await disposeServerPython();
  });

  const dsCtx = {
    datasetName: "orders",
    columns: [
      { name: "region", type: "string" },
      { name: "units", type: "number" },
      { name: "price", type: "number" },
    ],
    rows: [
      ["north", 10, 2.5],
      ["south", 4, 4.0],
      ["north", 6, 3.0],
      ["east", 8, 1.5],
    ] as (string | number | boolean | null)[][],
    totalRows: 4,
  };

  it("executes pure Python arithmetic and returns the expression value", async () => {
    const out = await runServerPython("21 * 2", dsCtx);
    expect(out.type).toBe("text");
    if (out.type === "text") expect(out.text).toContain("42");
  });

  it("runs pandas over the attached dataset and computes group aggregates", async () => {
    const out = await runServerPython(
      'df.groupby("region")["units"].sum().sort_values(ascending=False).index[0]',
      dsCtx,
    );
    expect(out.type).toBe("text");
    if (out.type === "text") expect(out.text).toContain("north");
  });

  it("captures print() output alongside the expression value", async () => {
    const out = await runServerPython('print("hello from python")\n1 + 1', dsCtx);
    expect(out.type).toBe("text");
    if (out.type === "text") {
      expect(out.text).toContain("hello from python");
      expect(out.text).toContain("2");
    }
  });

  it("captures a matplotlib figure as base64 PNG", async () => {
    const out = await runServerPython('plt.figure(figsize=(3,2)); plt.bar(["a","b"], [1,2]); plt.title("t")', dsCtx);
    expect(out.type).toBe("image");
    if (out.type === "image") {
      expect(out.image.mimeType).toBe("image/png");
      expect(out.image.data.length).toBeGreaterThan(100);
    }
  });

  it("surfaces Python errors as error outputs with the traceback", async () => {
    const out = await runServerPython("1 / 0", dsCtx);
    expect(out.type).toBe("error");
    if (out.type === "error") expect(out.message).toContain("ZeroDivisionError");
  });

  it("labels outputs with the pyodide-server kernel", async () => {
    const out = await runServerPython("2 ** 8", dsCtx);
    expect((out as { kernel?: string }).kernel).toBe("pyodide-server");
  });

  // ROADMAP 4.5 hardening proof: a runaway cell is terminated at the hard
  // cap and surfaces a structured, user-facing error — never a silent hang.
  // Runs the REAL worker against an infinite loop; the wall clock asserted
  // here is the same CELL_TIMEOUT_MS the UI reports.
  maybeDescribe("pyodide hardening (ROADMAP 4.5)", () => {
    it("terminates a runaway cell within the cap and returns a readable verdict", async () => {
      const mod = await import("@/lib/engine/python/python-kernel");
      const started = Date.now();
      const out = await runServerPython("\nwhile True:\n    pass\n", dsCtx);
      const elapsed = Date.now() - started;

      expect(out.type).toBe("error");
      if (out.type !== "error") return;
      expect(out.message).toContain("execution limit");
      expect(out.message).toContain("20-second");
      expect(out.message).toContain("How to fix");
      expect(out.message).toBe(mod.PYTHON_TIMEOUT_MESSAGE);
      // The kill must fire at the cap (20s), not hang indefinitely — a
      // generous upper bound keeps the assertion stable on cold CI runners.
      expect(elapsed).toBeLessThan(mod.PYTHON_CELL_TIMEOUT_MS + 15_000);
      // The kernel must recover: a follow-up cell still runs.
      const after = await runServerPython("6 * 7", dsCtx);
      expect(after.type).toBe("text");
    }, 60_000);
  });
});
