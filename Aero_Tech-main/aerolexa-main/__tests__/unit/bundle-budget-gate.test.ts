/**
 * Contract tests for the bundle budget gate (scripts/check-bundle-budgets.mjs).
 *
 * This gate shipped broken: it read `.next/build-manifest.json` -> `.pages`,
 * which on an App Router build holds only the phantom entries `/_app` and
 * `/_error`. It therefore measured two non-routes, hit no failure branch, and
 * printed "all routes within budget" while a 231 kB three.js chunk sat in the
 * first load of 17 real routes. A gate that cannot fail is worse than no gate,
 * so these tests build synthetic `.next` trees and assert the gate actually
 * fails — and, just as importantly, that it fails for the right reason.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "check-bundle-budgets.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

/**
 * A three.js string literal that survives minification. Must match the
 * SCENE_MARKER in the gate exactly — asserted below so the two cannot drift.
 */
const SCENE_MARKER = "WebGLRenderer: Context Lost";

/** A chunk of ~N kB raw, so the gate's 0.35 gzip factor reports ~0.35N kB. */
function chunkOfKb(kb: number): string {
  return "x".repeat(Math.round(kb * 1024));
}

interface Fixture {
  root: string;
  writeChunk(name: string, contents: string): string;
  writeManifest(pages: Record<string, string[]>): void;
  writeBaseline(routes: Record<string, number>, toleranceKB?: number): void;
  run(): { status: number; stdout: string };
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-budget-"));
  mkdirSync(path.join(root, ".next", "static", "chunks"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });

  return {
    root,
    writeChunk(name, contents) {
      writeFileSync(path.join(root, ".next", "static", "chunks", name), contents);
      return `static/chunks/${name}`;
    },
    writeManifest(pages) {
      writeFileSync(path.join(root, ".next", "app-build-manifest.json"), JSON.stringify({ pages }));
    },
    writeBaseline(routes, toleranceKB = 20) {
      writeFileSync(path.join(root, "scripts", "bundle-baseline.json"), JSON.stringify({ toleranceKB, routes }));
    },
    run() {
      try {
        const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    },
  };
}

describe("bundle budget gate", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function make(): Fixture {
    const f = fixture();
    dirs.push(f.root);
    return f;
  }

  it("uses the same scene marker as the gate, so the two cannot drift", () => {
    expect(SCRIPT_SOURCE).toContain(JSON.stringify(SCENE_MARKER));
    // The manifest is read without a leading slash by Next; if the gate ever
    // reintroduces a slash-prefixed key here, every route silently passes.
    expect(SCRIPT_SOURCE).toContain("static/chunks/${name}");
    expect(SCRIPT_SOURCE).not.toContain("`/static/chunks/${name}`");
  });

  it("passes a clean route that carries no scene runtime", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/onboarding/page": [small] });
    f.writeBaseline({ "/onboarding/page": 10 });

    const { status, stdout } = f.run();
    expect(status).toBe(0);
    expect(stdout).toContain("All bundle budgets satisfied");
  });

  it("fails when the scene runtime is in a route's first load", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    const scene = f.writeChunk("scene.js", `/* three */${SCENE_MARKER}${chunkOfKb(600)}`);
    f.writeManifest({ "/login/page": [small, scene] });
    f.writeBaseline({ "/login/page": 10 });

    const { status, stdout } = f.run();
    expect(status).toBe(1);
    expect(stdout).toContain("scene runtime is in its first load");
    expect(stdout).toContain("/login/page");
    // Must name the offending chunk so the failure is actionable.
    expect(stdout).toContain("scene.js");
  });

  it("fails on first-load growth beyond the ratchet tolerance", () => {
    const f = make();
    const heavy = f.writeChunk("heavy.js", chunkOfKb(600));
    f.writeManifest({ "/page": [heavy] });
    // Baseline 10 kB, tolerance 20 kB → ~210 kB is a regression.
    f.writeBaseline({ "/page": 10 });

    const { status, stdout } = f.run();
    expect(status).toBe(1);
    expect(stdout).toContain("over baseline");
  });

  it("tolerates growth within the ratchet tolerance", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(60));
    f.writeManifest({ "/page": [small] });
    f.writeBaseline({ "/page": 10 });

    expect(f.run().status).toBe(0);
  });

  it("accepts a route that shrinks, so improvements can land", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/page": [small] });
    f.writeBaseline({ "/page": 5000 });

    const { status, stdout } = f.run();
    expect(status).toBe(0);
    expect(stdout).toContain("under baseline");
  });

  it("enforces the absolute budget when BUDGET_ABSOLUTE=1", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/page": [small] });
    f.writeBaseline({ "/page": 1 });

    // Under the ratchet (baseline 1 kB + 20 kB tolerance) but over the
    // plan's 300 kB headline bar, which only absolute mode checks.
    const relaxed = f.run();
    expect(relaxed.status).toBe(0);

    const strict = (() => {
      try {
        const stdout = execFileSync(process.execPath, [SCRIPT], {
          cwd: f.root,
          encoding: "utf8",
          env: { ...process.env, BUDGET_ABSOLUTE: "1", BUDGET_FIRST_LOAD_KB: "1" },
        });
        return { status: 0, stdout };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    })();
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("over absolute budget");
  });

  it("ignores API route handlers, which have no client bundle", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/api/auth/login/route": [small], "/page": [small] });
    f.writeBaseline({ "/page": 10 });

    const { status, stdout } = f.run();
    expect(status).toBe(0);
    expect(stdout).not.toContain("/api/auth/login/route");
  });

  it("refuses to pass when no build output is present", () => {
    const f = make();
    const { status, stdout } = f.run();
    expect(status).toBe(1);
    expect(stdout).toContain("app-build-manifest.json");
  });

  it("refuses to pass when the manifest lists no client routes", () => {
    const f = make();
    f.writeManifest({});
    const { status, stdout } = f.run();
    expect(status).toBe(1);
    expect(stdout).toContain("refusing to pass vacuously");
  });

  it("warns rather than silently passing when no baseline is recorded", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/page": [small] });

    const { status, stdout } = f.run();
    expect(status).toBe(0);
    expect(stdout).toContain("No baseline");
  });

  it("warns when the scene marker matches nothing, since the check is then vacuous", () => {
    const f = make();
    const small = f.writeChunk("small.js", chunkOfKb(50));
    f.writeManifest({ "/page": [small] });
    f.writeBaseline({ "/page": 10 });

    const { status, stdout } = f.run();
    expect(status).toBe(0);
    // No chunk carries the marker here, so the 3D check cannot bite.
    expect(stdout).toContain("VACUOUS");
  });
});
