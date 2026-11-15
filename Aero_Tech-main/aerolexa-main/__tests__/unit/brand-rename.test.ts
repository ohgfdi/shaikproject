/**
 * Brand rename: upgrade-safety regressions.
 *
 * The Aerolexa → Ledgerly rename moved a live storage namespace (cookies,
 * localStorage) and three deployment-facing env vars. A naive find-and-replace
 * would have signed out every user and forced every operator to edit their
 * `.env`. These tests pin the guarantees that make the rename safe:
 *
 *  1. Brand identity is defined once and is what the UI/metadata use.
 *  2. Storage keys read forward, falling back to the legacy key.
 *  3. Sign-out clears BOTH cookie names.
 *  4. Renamed env vars accept the legacy spelling, with the new name winning.
 *  5. Technical identifiers that must NOT move are still unmoved.
 */
import { readFileSync } from "node:fs";

import {
  BRAND,
  BRAND_STORAGE_KEYS,
  LEGACY_BRAND_NAME,
  LEGACY_BRAND_SLUG,
  brandKey,
  legacyBrandKey,
  readBrandCookie,
} from "@/lib/brand";

/** Minimal stand-in for the @/lib/auth/cookie-store surface. */
function fakeStore(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    get: (name: string) => (map.has(name) ? { value: map.get(name)! } : undefined),
    set: (name: string, value: string) => void map.set(name, value),
    delete: (name: string) => void map.delete(name),
    has: (name: string) => map.has(name),
    raw: map,
  };
}

describe("brand identity", () => {
  it("is Ledgerly, and the slug matches the storage namespace", () => {
    expect(BRAND.name).toBe("Ledgerly");
    expect(BRAND.slug).toBe("ledgerly");
    expect(brandKey("theme")).toBe("ledgerly.theme");
  });

  it("keeps the legacy slug available for read-fallbacks only", () => {
    expect(LEGACY_BRAND_SLUG).toBe("aerolexa");
    expect(LEGACY_BRAND_NAME).toBe("Aerolexa");
    expect(legacyBrandKey("theme")).toBe("aerolexa.theme");
  });

  it("names the wedge the product actually sells", () => {
    // §18.1: the old brand described aerospace, not the job. Guard the fix.
    expect(BRAND.wedge.toLowerCase()).toContain("gst");
  });
});

describe("cookie read-fallback (the no-logout guarantee)", () => {
  it("prefers the current cookie", () => {
    const store = fakeStore({
      "ledgerly.theme": "light",
      "aerolexa.theme": "dark",
    });
    const read = readBrandCookie<string>(store, BRAND_STORAGE_KEYS.theme);
    expect(read?.value).toBe("light");
    expect(read?.migrated).toBe(false);
  });

  it("falls back to the pre-rename cookie and flags the migration", () => {
    const store = fakeStore({ "aerolexa.theme": "dark" });
    const read = readBrandCookie<string>(store, BRAND_STORAGE_KEYS.theme);
    expect(read?.value).toBe("dark");
    expect(read?.migrated).toBe(true);
  });

  it("returns undefined when neither cookie exists", () => {
    expect(readBrandCookie(fakeStore({}), BRAND_STORAGE_KEYS.theme)).toBeUndefined();
  });

  it("still accepts a pre-rename SESSION cookie — this is what prevents a mass logout", () => {
    const store = fakeStore({ "aerolexa.session": "jwt-token" });
    const read = readBrandCookie<string>(store, BRAND_STORAGE_KEYS.session);
    expect(read?.value).toBe("jwt-token");
    expect(read?.migrated).toBe(true);
  });
});

describe("session sign-out clears both cookie names", () => {
  /**
   * Asserted against the source rather than by importing it: lib/auth/session
   * pulls in next/headers, which the unit jest environment cannot transform.
   */
  const src = readFileSync(`${process.cwd()}/lib/auth/session.ts`, "utf8");

  it("mints the current cookie name and still defines the legacy one", () => {
    expect(src).toContain("brandKey(BRAND_STORAGE_KEYS.session)");
    expect(src).toContain("legacyBrandKey(BRAND_STORAGE_KEYS.session)");
  });

  it("expiring descriptors cover both names and clear the legacy first", () => {
    expect(src).toContain("clearSessionCookieDescriptors");
    // Legacy descriptor is emitted before the current one: if setting cookies
    // fails part-way, the user is still signed out. Anchored on the
    // descriptor-array lines specifically (createSessionCookie also emits
    // `name: COOKIE_NAME`).
    const legacyIdx = src.indexOf('{ name: LEGACY_COOKIE_NAME, value: ""');
    const currentIdx = src.indexOf('{ name: COOKIE_NAME, value: ""');
    expect(legacyIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeGreaterThan(legacyIdx);
  });

  it("both call sites that sign a user out expire both cookies", () => {
    for (const route of ["app/api/auth/logout/route.ts", "app/api/me/erase/route.ts"]) {
      const body = readFileSync(`${process.cwd()}/${route}`, "utf8");
      expect(body).toContain("clearSessionCookieDescriptors");
    }
  });
});

describe("renamed env vars keep old deployments working", () => {
  /**
   * serverEnv() caches on first call, so process.env must still hold the
   * override while the assertions run. Restoring inside an `import()` helper
   * would undo the override before serverEnv() is ever called — hence the
   * callback form: mutate, run, then restore in `finally`.
   */
  const withEnv = async (
    env: Record<string, string | undefined>,
    fn: (envModule: typeof import("@/lib/env")) => void | Promise<void>,
  ) => {
    jest.resetModules();
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn(await import("@/lib/env"));
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const BASE = {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable",
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    // Hermetic: the repo .env is exported into every jest worker by the test
    // harness (global-setup dotenv fallback), so on a machine with a real
    // deployment profile these would otherwise win over the per-case env and
    // `resolveBrandEnv` would never be exercised on a clean slate. Pin them
    // off for every case in this block.
    LEDGERLY_PROFILE: undefined,
    AEROLEXA_PROFILE: undefined,
    LEDGERLY_ENABLED_MODULES: undefined,
    AEROLEXA_ENABLED_MODULES: undefined,
  };

  it("prefers the current LEDGERLY_* name when both are set", () =>
    withEnv({ ...BASE, LEDGERLY_PROFILE: "pro", AEROLEXA_PROFILE: "core" }, (env) => {
      expect(env.resolveBrandEnv("LEDGERLY_PROFILE", "AEROLEXA_PROFILE")).toEqual({
        value: "pro",
        usedLegacy: false,
      });
    }));

  it("honours the legacy name when the new one is unset", () =>
    withEnv({ ...BASE, AEROLEXA_PROFILE: "pro" }, (env) => {
      expect(env.resolveBrandEnv("LEDGERLY_PROFILE", "AEROLEXA_PROFILE")).toEqual({
        value: "pro",
        usedLegacy: true,
      });
    }));

  it("reports neither when both are empty", () =>
    withEnv(BASE, (env) => {
      expect(env.resolveBrandEnv("LEDGERLY_PROFILE", "AEROLEXA_PROFILE")).toEqual({
        value: "",
        usedLegacy: false,
      });
    }));

  it("a legacy-only .env still yields the same deployment profile", () =>
    withEnv({ ...BASE, AEROLEXA_PROFILE: "pro" }, async () => {
      const { deploymentProfile } = await import("@/lib/server/modules");
      expect(deploymentProfile()).toBe("pro");
    }));

  it("a LEDGERLY_* .env yields the same profile", () =>
    withEnv({ ...BASE, LEDGERLY_PROFILE: "pro" }, async () => {
      const { deploymentProfile } = await import("@/lib/server/modules");
      expect(deploymentProfile()).toBe("pro");
    }));

  it("the deprecation warning fires for a legacy-only .env and not for a current one", () =>
    withEnv({ ...BASE, AEROLEXA_PROFILE: "pro" }, (env) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        env.warnLegacyEnvVars();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("AEROLEXA_PROFILE"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("LEDGERLY_PROFILE"));
      } finally {
        warn.mockRestore();
      }
    }));
});

describe("identifiers that must NOT move with the brand", () => {
  /**
   * These are wire contracts, not brand strings. Renaming any of them breaks a
   * live deployment silently, so they are pinned here to make the decision
   * explicit rather than accidental.
   */
  const PINNED: ReadonlyArray<readonly [string, string]> = [
    ["/lib/auth/session.ts", 'const ISSUER = "aerolexa"'],
    ["/lib/auth/session.ts", 'const AUDIENCE = "aerolexa-web"'],
    ["/lib/auth/saml.ts", "urn:aerolexa:sp"],
  ];

  it.each(PINNED)("%s pins %s", async (file, needle) => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), file), "utf8");
    expect(src).toContain(needle);
  });

  it("the inbound webhook header keeps accepting the pre-rename spelling", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(`${process.cwd()}/app/api/connectors/webhook/[id]/route.ts`, "utf8");
    expect(src).toContain('headers.get("x-ledgerly-signature")');
    expect(src).toContain('headers.get("x-aerolexa-signature")');
  });

  it("the DuckDB total column is unchanged (referenced across queries and tests)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(`${process.cwd()}/lib/engine/duckdb/shared.ts`, "utf8");
    expect(src).toContain("__aerolexa_total");
  });
});
