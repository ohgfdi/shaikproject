/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts", "**/*.test.tsx"],
  // Playwright owns the e2e journey; Jest covers unit, component and API tests.
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/e2e/"],
  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          transform: {
            react: { runtime: "automatic" },
          },
          target: "es2021",
        },
      },
    ],
    // Prisma 7 ships its query compiler as ESM (.mjs). The default pattern
    // above does not match ".mjs" (the dot must precede t|j), so these files
    // would reach node as raw ESM and blow up every DB-backed suite.
    "^.+\\.mjs$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "ecmascript" },
          target: "es2021",
        },
        module: { type: "commonjs" },
      },
    ],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // The generated Prisma 7 client loads its query compiler from an ESM
  // runtime file (query_compiler_*.sqlite.mjs / postgres.mjs). SWC must
  // transform those to CJS or every DB-backed unit suite dies with
  // "Unexpected token 'export'" the moment the client boots.
  // three/examples/jsm is the same story: three ships its addons as untranspiled
  // ESM .js, so anything importing RGBELoader (the HDRI ladder) needs it run
  // through the transform above rather than handed to node raw.
  transformIgnorePatterns: ["/node_modules/(?!@prisma/client/runtime|three/examples)"],
  // Run before the framework and before any app module: supplies AUTH_SECRET /
  // DATABASE_URL from the tracked .env.test so suites do not depend on the
  // developer's shell (see __tests__/env.ts).
  setupFiles: ["<rootDir>/__tests__/env.ts"],
  setupFilesAfterEnv: ["<rootDir>/__tests__/setup.ts"],
  globalSetup: "<rootDir>/__tests__/api/global-setup.cjs",
  globalTeardown: "<rootDir>/__tests__/api/global-teardown.cjs",
  testTimeout: 20000,
  // One pass through a scratch database — no parallelism needed.
  maxWorkers: 1,
  clearMocks: true,
};
