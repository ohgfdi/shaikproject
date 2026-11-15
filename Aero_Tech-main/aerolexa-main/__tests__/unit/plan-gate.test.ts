/**
 * Client plan-gate parsing — the contract between a 402 and an upgrade notice.
 */

import { PLAN_GATE_EXPLANATION, planGateFromError, planGateLabel } from "@/lib/client/plan-gate";

function planError(message: string, status = 402, code = "PLAN_UPGRADE_REQUIRED") {
  return { status, code, message };
}

describe("planGateFromError", () => {
  it("extracts the pro remedy the server emits", () => {
    const gate = planGateFromError(
      planError("Scheduled notebook runs is not in your current plan. Remedy: PLAN_REQUIRED:pro — upgrade."),
    );
    expect(gate).toEqual({
      plan: "pro",
      message: "Scheduled notebook runs is not in your current plan. Remedy: PLAN_REQUIRED:pro — upgrade.",
    });
  });

  it("extracts the firm remedy for governance features", () => {
    expect(planGateFromError(planError("Remedy: PLAN_REQUIRED:firm — upgrade."))?.plan).toBe("firm");
  });

  it("returns null for ordinary failures", () => {
    expect(planGateFromError(planError("Something broke", 500, "INTERNAL"))).toBeNull();
    expect(planGateFromError(new Error("Remedy: PLAN_REQUIRED:pro"))).toBeNull();
    expect(planGateFromError(null)).toBeNull();
    expect(planGateFromError(planError("Remedy: PLAN_REQUIRED:enterprise"))).toBeNull();
  });

  it("labels plans and states the no-result-change rule", () => {
    expect(planGateLabel("pro")).toBe("Pro");
    expect(planGateLabel("firm")).toBe("Firm");
    expect(PLAN_GATE_EXPLANATION).toContain("computed number");
  });
});
