/**
 * Temporary `process.env` overrides for unit suites.
 *
 * Two flavours, and the difference matters:
 *
 *  - `withEnv` runs a SYNCHRONOUS body and restores the environment when it
 *    returns.
 *  - `withEnvAsync` runs an ASYNC body and restores the environment only after
 *    the body's promise settles.
 *
 * Handing an async body to `withEnv` used to be a real footgun here: the body's
 * promise was never awaited by the test, so (a) the environment was restored
 * under the body's feet and (b) any failed assertion inside it escaped as an
 * *unhandled rejection*. Node treats those as fatal, so instead of one red test
 * the Jest worker died and the ENTIRE run aborted with no suite summary — that
 * is exactly how `__tests__/unit/mail-transport.test.ts` failed on a fresh
 * clone. Use `withEnvAsync` for anything that touches `await`.
 *
 * Both helpers drop the memoized `serverEnv()` on the way out, so a suite can
 * re-validate the env after a change in either direction and never depends on
 * the order its tests run in.
 */

import { __resetServerEnvForTests } from "@/lib/env";

type EnvVars = Record<string, string | undefined>;

function apply(vars: EnvVars): EnvVars {
  const saved: EnvVars = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return saved;
}

function restore(saved: EnvVars): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetServerEnvForTests();
}

/** Run a synchronous body with temporary env overrides. */
export function withEnv<T>(vars: EnvVars, fn: () => T): T {
  const saved = apply(vars);
  try {
    return fn();
  } finally {
    restore(saved);
  }
}

/** Run an async body with temporary env overrides; restores after it settles. */
export async function withEnvAsync<T>(vars: EnvVars, fn: () => Promise<T>): Promise<T> {
  const saved = apply(vars);
  try {
    return await fn();
  } finally {
    restore(saved);
  }
}
