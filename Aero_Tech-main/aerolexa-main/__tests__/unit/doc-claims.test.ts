/**
 * Explainable-number checks for the trust claims that are easy to let drift.
 *
 * The repo's defining promise is "every claim is provable". The RLS incident
 * showed the failure mode: a constant said one thing, the scorecard another,
 * and a test pinned the wrong one. These guards cover the claims whose truth
 * lives in more than one file. They are not a completeness proof — they are
 * the cheap tripwires for the drift that actually happened.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("RLS claims", () => {
  it("the wiring flag is false while the query layer is unwrapped", () => {
    const status = read("lib/server/rls-status.ts");
    expect(status).toContain("RLS_QUERY_LAYER_WIRED = false");
    expect(status).toContain("RLS_UNWRAPPED_BASELINE");
  });

  it("no doc claims the flag is true", () => {
    for (const file of ["README.md", "ROADMAP.md", "docs/capability-scorecard.md", "docs/security-and-data.md"]) {
      const source = read(file);
      expect(source).not.toContain("RLS_QUERY_LAYER_WIRED = true");
    }
  });

  it("the scorecard rates P21 and E19 PARTIAL, matching the code", () => {
    const scorecard = read("docs/capability-scorecard.md");
    expect(scorecard).toMatch(/^\| P21 \|.*\*\*PARTIAL\*\*/m);
    expect(scorecard).toMatch(/^\| E19 \|.*\*\*PARTIAL\*\*/m);
  });
});

describe("plan-gate call sites", () => {
  it("never pass an options object where the label string belongs", () => {
    // The 2026-11-15 type error: requirePlanFeature(id, feature, { featureLabel }).
    // TypeScript catches it today; this keeps the source honest for grep-based
    // audits and for any JS consumer that bypasses the compiler.
    const files = [
      "app/api/scheduled-notebooks/route.ts",
      "app/api/audit/export/route.ts",
      "app/api/connectors/route.ts",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).toContain("requirePlanFeature(");
      expect(source).not.toContain("{ featureLabel");
    }
  });
});

describe("pilot + CI surfaces", () => {
  it("ships the pilot-readiness command and script", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["pilot:readiness"]).toContain("scripts/pilot-readiness.mts");
    expect(existsSync(path.resolve(process.cwd(), "scripts/pilot-readiness.mts"))).toBe(true);
  });

  it("runs CI from the repository root against the app working directory", () => {
    // GitHub only reads .github/workflows at the repo root; the app is nested.
    const workflowFile = path.resolve(process.cwd(), "../../.github/workflows/ci.yml");
    expect(existsSync(workflowFile)).toBe(true);
    const workflow = readFileSync(workflowFile, "utf8");
    expect(workflow).toContain("working-directory: Aero_Tech-main/aerolexa-main");
    expect(workflow).toContain("defaults:");
    expect(workflow).toContain("cache-dependency-path: Aero_Tech-main/aerolexa-main/package-lock.json");
  });
});
