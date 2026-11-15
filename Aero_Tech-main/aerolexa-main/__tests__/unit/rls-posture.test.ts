/**
 * RLS posture matrix: development on SQLite is fine, production on SQLite is a
 * warning, production Postgres without RLS is a warning with a remedy, and a
 * coherent Postgres+RLS deployment is ok.
 */

import { rlsPosture } from "@/lib/server/rls-posture";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { NODE_ENV: "development", ...overrides };
}

describe("RLS posture", () => {
  it("does not warn about the SQLite development profile", () => {
    const posture = rlsPosture(env({ DATABASE_URL: "file:../data/ledgerly.db" }));
    expect(posture.database).toBe("other");
    expect(posture.enforced).toBe(false);
    expect(posture.severity).toBe("ok");
  });

  it("warns when production still runs on SQLite", () => {
    const posture = rlsPosture(env({ NODE_ENV: "production", DATABASE_URL: "file:../data/ledgerly.db" }));
    expect(posture.severity).toBe("warn");
    expect(posture.summary).toContain("SQLite");
    expect(posture.remedy).toContain("deploy-postgres");
  });

  it("warns when production Postgres has RLS off and names the remedy", () => {
    const posture = rlsPosture(env({ NODE_ENV: "production", DATABASE_URL: "postgresql://db/app" }));
    expect(posture.database).toBe("postgres");
    expect(posture.enforced).toBe(false);
    expect(posture.severity).toBe("warn");
    expect(posture.remedy).toContain("RLS_ENABLED=true");
    expect(posture.remedy).toContain("docs/rls-default-on.md");
  });

  it("refuses RLS while the query layer is not wrapped", () => {
    const posture = rlsPosture(
      env({ NODE_ENV: "production", DATABASE_URL: "postgresql://db/app", RLS_ENABLED: "true" }),
    );
    expect(posture.requested).toBe(true);
    expect(posture.enforced).toBe(false);
    expect(posture.configError).toContain("query layer was wrapped");
    expect(posture.remedy).toContain("tenancy:audit");
    expect(posture.severity).toBe("critical");
  });

  it("flags RLS_ENABLED on SQLite as a no-op config error", () => {
    const posture = rlsPosture(env({ DATABASE_URL: "file:./app.db", RLS_ENABLED: "true" }));
    expect(posture.configError).toContain("no-op");
    expect(posture.enforced).toBe(false);
  });
});
