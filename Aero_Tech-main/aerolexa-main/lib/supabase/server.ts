import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Server-side Supabase clients.
 *
 * Two deliberate variants:
 *
 *   getSupabaseServerClient()  — anonymous key, no session persistence. Use it
 *                                for public reads; it is still subject to Row
 *                                Level Security.
 *   getSupabaseAdminClient()   — service-role key. BYPASSES RLS, so it is for
 *                                trusted server work only (seeding, migrations
 *                                helpers, background jobs). Never import this
 *                                from client code, never log its key.
 *
 * This module is server-only by convention, exactly like `lib/db.ts`: importing
 * it into a client component would pull the service-role credential into the
 * browser graph. Only `NEXT_PUBLIC_*` values may cross that boundary.
 */

/** Whether the anonymous server client can be created (URL + anon key set). */
export function isSupabaseServerConfigured(): boolean {
  return Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_URL && publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Anonymous server client. Sessions are NOT persisted — a server process
 * serves many users, so keeping a token on disk would leak one user's session
 * into another's request.
 */
export function getSupabaseServerClient(): SupabaseClient {
  if (!isSupabaseServerConfigured()) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
        "in your .env (see .env.example).",
    );
  }
  return createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Privileged server client (service role). Fails with a readable error when the
 * key is absent rather than quietly downgrading to an anonymous client, which
 * would turn an authorization bug into a silent 404.
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (!publicEnv.NEXT_PUBLIC_SUPABASE_URL) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL in your .env (see .env.example).",
    );
  }
  const serviceRoleKey = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. It is server-only and bypasses Row Level Security — " +
        "add it to your .env and never expose it to the browser (see .env.example).",
    );
  }
  return createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
