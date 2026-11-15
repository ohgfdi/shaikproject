/**
 * Shared Python interpreter resolution for runtime-gated test suites.
 *
 * Problem this solves: the project `.venv` carries the full scientific stack
 * (numpy / scipy / pandas / scikit-learn / nbformat), while an incidental
 * `python3` on PATH usually has none. Suites that executed exported scripts
 * through bare `python3` therefore "passed" while silently downgrading to no
 * assertions — a skip hidden inside a green test, which the repo's zero-skip
 * discipline (README → "Zero-skipped-tests gate") explicitly forbids.
 *
 * Resolution order (first match wins):
 *  1. `$AEROLEXA_TEST_PYTHON` — explicit override for CI or reproducibility.
 *  2. The project-local venv: `<repoRoot>/.venv/bin/python`.
 *  3. `python3` on PATH — only if it can import the scientific stack.
 *
 * A failing venv probe must NOT silently downgrade to a weaker interpreter.
 * `resolveTestPython` throws with an actionable message in that case; suites
 * that legitimately tolerate a missing stack wrap the call in try/catch,
 * announce the skip with a console.warn, and skip through `describe.skip` /
 * `it.skip` — so the skip is visible in the Jest output, never silent.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "../..");

/** Modules the exported/oracle scripts import at runtime. */
const REQUIRED_MODULES = ["numpy", "pandas", "scipy"];

/** Interpreter candidates in priority order (explicit override, venv, PATH). */
function candidates(): { bin: string; source: TestPython["source"] }[] {
  const list: { bin: string; source: TestPython["source"] }[] = [];
  if (process.env.AEROLEXA_TEST_PYTHON) {
    list.push({ bin: process.env.AEROLEXA_TEST_PYTHON, source: "AEROLEXA_TEST_PYTHON" });
  }
  list.push({ bin: path.join(REPO_ROOT, ".venv", "bin", "python"), source: "project .venv" });
  list.push({ bin: "python3", source: "PATH python3" });
  return list;
}

/**
 * Probe snippet: exit 0 iff every required module is importable. Note that
 * `importlib.util` must be imported explicitly — `import importlib` alone does
 * not attach the `util` submodule on Python ≥ 3.12.
 */
const PROBE = (modules: string[]) =>
  `import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(m) for m in ${JSON.stringify(modules)}) else 1)`;

/** True if `python` can import the scientific stack the exported scripts need. */
function canImport(python: string, modules: string[]): boolean {
  try {
    execFileSync(python, ["-c", PROBE(modules)], { timeout: 20_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface TestPython {
  /** Interpreter command to pass to execFile/spawn (may be an absolute path). */
  bin: string;
  /** Where it was found — included in failure messages and skip announcements. */
  source: "AEROLEXA_TEST_PYTHON" | "project .venv" | "PATH python3";
}

/**
 * Resolve a scientific-stack interpreter or throw. Explicit override
 * ($AEROLEXA_TEST_PYTHON) is honoured verbatim and never silently ignored.
 */
export function resolveTestPython(): TestPython {
  const problems: string[] = [];
  for (const { bin, source } of candidates()) {
    // PATH-style commands ("python3") resolve via spawn's PATH lookup; only
    // filesystem candidates are checked with existsSync.
    if (source !== "AEROLEXA_TEST_PYTHON" && bin.includes(path.sep) && !existsSync(bin)) {
      problems.push(`${bin} — not found`);
      continue;
    }
    if (canImport(bin, REQUIRED_MODULES)) return { bin, source };
    problems.push(`${bin} — cannot import ${REQUIRED_MODULES.join(", ")}`);
  }
  throw new Error(
    "No Python interpreter with the scientific stack was found for the runtime-gated suites:\n  " +
      problems.join("\n  ") +
      "\nInstall the project venv (python3 -m venv .venv && .venv/bin/pip install numpy scipy pandas scikit-learn nbformat)" +
      " or point AEROLEXA_TEST_PYTHON at a suitable interpreter.",
  );
}

/**
 * Resolve for suites that can legitimately skip when no stack is present.
 * Announces the reason via console.warn so the skip is earned and visible —
 * never a silent downgrade inside a passing test.
 */
export function resolveTestPythonOrAnnounce(suiteLabel: string): TestPython | null {
  try {
    return resolveTestPython();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`${suiteLabel}: skipping — ${(err as Error).message}`);
    return null;
  }
}

/**
 * True when the interpreter can import the optional `modules` (e.g. nbformat).
 * Used to gate only the assertions that genuinely need the extra package,
 * without weakening the rest of the suite.
 */
export function canImportModules(python: string, modules: string[]): boolean {
  return canImport(python, modules);
}
