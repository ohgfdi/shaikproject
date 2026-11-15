import fs from "node:fs";
import path from "node:path";

import { openApiSpec, openApiSpecProblems } from "@/lib/server/openapi-spec";

/**
 * OpenAPI contract gate (ROADMAP 5.6: "contract test fails if a route drifts").
 *
 * 1. Spec coherence — every $ref resolves, security schemes are declared,
 *    operationIds unique (openApiSpecProblems).
 * 2. Route drift — every public-v1 API-key route on disk must appear in the
 *    spec paths, and every /auth/api-keys handler must be documented too.
 *    Adding a public route without documenting it fails this test.
 */
describe("openapi contract", () => {
  it("is internally coherent (refs resolve, schemes declared, operationIds unique)", () => {
    expect(openApiSpecProblems(openApiSpec)).toEqual([]);
  });

  it("serves the same spec object the JSON route serves", () => {
    // Guards against the spec being forked back into an inline literal.
    const routeSource = fs.readFileSync(path.join(process.cwd(), "app/api/public/openapi.json/route.ts"), "utf8");
    expect(routeSource).not.toMatch(/openapi:\s*"3/);
    expect(routeSource).toMatch(/from "@\/lib\/server\/openapi-spec"/);
  });

  it("documents every public v1 route that exists on disk", () => {
    const v1Dir = path.join(process.cwd(), "app/api/public/v1");
    const documented = new Set(Object.keys(openApiSpec.paths));

    const routeFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") routeFiles.push(full);
      }
    };
    walk(v1Dir);

    expect(routeFiles.length).toBeGreaterThan(0);

    for (const file of routeFiles) {
      const rel = path.relative(v1Dir, file).replace(/\\/g, "/");
      const apiPath =
        "/" +
        rel
          .replace(/\/route\.ts$/, "")
          .replace(/\[\.\.\..*\]/g, "")
          .replace(/\[(\w+)\]/g, "{$1}");
      // /index → /, /datasets/{id} stays
      const normalized = apiPath.replace(/\/index$/, "") || "/";
      expect(documented).toContain(normalized);
    }
  });

  it("documents the session-auth API key management routes", () => {
    const documented = new Set(Object.keys(openApiSpec.paths));
    expect(documented.has("/auth/api-keys")).toBe(true);
    expect(documented.has("/auth/api-keys/{keyId}")).toBe(true);
  });

  it("has a swagger ui shell wired to the shared spec", () => {
    const shell = fs.readFileSync(path.join(process.cwd(), "public/vendor/swagger-ui/index.html"), "utf8");
    expect(shell).toContain("/api/public/openapi.json");
    expect(shell).toContain("/vendor/swagger-ui/swagger-ui-bundle.js");
  });
});
