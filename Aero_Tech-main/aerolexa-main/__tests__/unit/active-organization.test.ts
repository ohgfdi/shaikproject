import { selectActiveMembership } from "@/lib/auth/active-org";

const memberships = [
  { organizationId: "org_a", role: "OWNER" },
  { organizationId: "org_b", role: "MEMBER" },
  { organizationId: "org_c", role: "AUDITOR" },
];

describe("selectActiveMembership", () => {
  it("honours an explicitly selected organization", () => {
    expect(selectActiveMembership(memberships, "org_b")?.organizationId).toBe("org_b");
  });

  it("falls back to the first membership for a new user", () => {
    expect(selectActiveMembership(memberships, null)?.organizationId).toBe("org_a");
  });

  it("ignores a stale or revoked selection instead of leaking another tenant", () => {
    expect(selectActiveMembership(memberships, "org_revoked")?.organizationId).toBe("org_a");
  });

  it("returns undefined when the user has no memberships", () => {
    expect(selectActiveMembership([], "org_a")).toBeUndefined();
  });
});
