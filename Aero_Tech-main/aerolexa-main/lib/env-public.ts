import { z } from "zod";

/**
 * Public, non-secret environment — safe to import from CLIENT code.
 *
 * Split out of `lib/env.ts`. That module also validates server-only secrets and
 * (since the filing work) imports the GSTN RSA primitives from
 * `lib/engine/filing/crypto.ts`, which uses `node:crypto`. A browser bundle that
 * only needs `NEXT_PUBLIC_*` values — the DuckDB-wasm engine and the Pyodide
 * notebook loader — would otherwise drag the whole server schema, and
 * `node:crypto` with it, into the client graph and fail the webpack build with
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled`.
 *
 * Rule of thumb:
 *   client code  → `@/lib/env-public`
 *   server code  → `@/lib/env`
 *
 * Prefixes: only `NEXT_PUBLIC_*` values live here, so everything in this file is
 * inlined into the client bundle by Next.js — never add a secret.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  // Optional Pyodide asset URL override. The notebook always attempts Pyodide;
  // the deterministic DSL is used only when the browser kernel cannot load.
  NEXT_PUBLIC_PYODIDE_URL: z.string().default(""),
  // When true AND wasm/worker assets are served at /duckdb/* (copied at
  // install/dev time), the SQL Lab runs queries in-browser with DuckDB-wasm;
  // the server API is the automatic fallback. False disables the browser path.
  NEXT_PUBLIC_DUCKDB_ENABLED: bool(true),
  // Supabase (Postgres/Storage/Realtime). Both are OPTIONAL: with them unset
  // the app behaves exactly as before and lib/supabase/* reports "not
  // configured" instead of failing boot. Only the publishable anon key belongs
  // here — it is inlined into the client bundle. The service-role key is
  // server-only (lib/env.ts).
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional().default(""),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional().default(""),
});

export type PublicEnv = z.infer<typeof publicSchema>;

export function loadPublicEnv(): PublicEnv {
  try {
    return publicSchema.parse(process.env);
  } catch {
    // Public settings are cosmetic — never fail boot on them.
    return {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_PYODIDE_URL: "",
      NEXT_PUBLIC_DUCKDB_ENABLED: true,
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    };
  }
}

/** Public, non-secret env. Safe to call anywhere. */
export const publicEnv: PublicEnv = loadPublicEnv();
