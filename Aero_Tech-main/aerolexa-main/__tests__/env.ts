/**
 * Test environment bootstrap.
 *
 * `.env.test` is the tracked test contract (scratch DATABASE_URL + AUTH_SECRET),
 * but nothing loads it: Jest workers start with an empty environment, so any
 * suite that reaches `loadServerEnv()` — mail footers, TOTP sealing, webhook
 * verification, assistant limits — failed with "AUTH_SECRET: Required" on a
 * fresh checkout even though `npm test` is documented to work out of the box.
 *
 * This runs as a `setupFiles` entry (before the test framework and before any
 * application module is imported), so `lib/env.ts` sees a complete environment
 * whichever suite imports it first.
 *
 * Precedence mirrors `__tests__/api/global-setup.cjs`: a variable already set
 * in the real environment (CI, a developer's shell) always wins, then
 * `.env.test`, then `.env` fills any remaining gaps.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

function load(file: string): void {
  const full = path.join(root, file);
  if (!existsSync(full)) return;
  for (const line of readFileSync(full, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

load(".env.test");
load(".env");
