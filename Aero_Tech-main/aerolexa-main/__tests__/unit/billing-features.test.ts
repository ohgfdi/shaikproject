/**
 * Plan feature matrix + remedy contract.
 *
 * The UI, the API gates and support all rely on ONE matrix: if `featuresForPlan`
 * disagrees with PLAN_ENTITLEMENTS, an upgrade prompt will either lie or a paid
 * user will hit a 402. These oracles pin the mapping and the grep-able remedy
 * token (`PLAN_REQUIRED:<plan>`) that clients act on.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "billing-features-test-secret-0123456789ab";

import {
  PLAN_FEATURES,
  featuresForPlan,
  minimumPlanFor,
  planHasFeature,
  planRequiredRemedy,
} from "@/lib/server/billing-features";
import { PLAN_ENTITLEMENTS } from "@/lib/server/entitlements";

describe("plan feature matrix", () => {
  it("free grants no distribution feature", () => {
    expect(featuresForPlan("free")).toEqual([]);
    for (const feature of PLAN_FEATURES) {
      expect(planHasFeature("free", feature)).toBe(false);
    }
  });

  it("pro grants distribution but not governance", () => {
    const pro = featuresForPlan("pro");
    expect(pro).toEqual(
      expect.arrayContaining(["publicShareLinks", "scheduledReports", "scheduledConnectorSync", "apiKeys"]),
    );
    expect(pro).not.toContain("sso");
    expect(pro).not.toContain("auditExport");
    expect(pro).not.toContain("orgSeats");
  });

  it("firm adds seats, SSO and audit export", () => {
    const firm = featuresForPlan("firm");
    for (const feature of PLAN_FEATURES) expect(firm).toContain(feature);
  });

  it("mirrors PLAN_ENTITLEMENTS and never invents a feature", () => {
    for (const plan of ["free", "pro", "firm"] as const) {
      const features = featuresForPlan(plan);
      expect(features).not.toContain("externalConnectors");
      if (PLAN_ENTITLEMENTS[plan].publicShareLinks) expect(features).toContain("publicShareLinks");
      if (!PLAN_ENTITLEMENTS[plan].publicShareLinks) expect(features).not.toContain("publicShareLinks");
      if (PLAN_ENTITLEMENTS[plan].scheduledNotebookPublish) expect(features).toContain("scheduledNotebookPublish");
    }
  });

  it("names the cheapest plan that grants each feature", () => {
    expect(minimumPlanFor("publicShareLinks")).toBe("pro");
    expect(minimumPlanFor("scheduledConnectorSync")).toBe("pro");
    expect(minimumPlanFor("orgSeats")).toBe("firm");
    expect(minimumPlanFor("sso")).toBe("firm");
    expect(minimumPlanFor("auditExport")).toBe("firm");
  });

  it("emits a grep-able remedy token", () => {
    expect(planRequiredRemedy("apiKeys")).toBe("PLAN_REQUIRED:pro");
    expect(planRequiredRemedy("auditExport")).toBe("PLAN_REQUIRED:firm");
  });
});
