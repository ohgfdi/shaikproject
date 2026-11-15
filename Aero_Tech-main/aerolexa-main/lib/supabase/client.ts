import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env-public";

/**
 * Browser Supabase client (the publishable anon key only).
 *
 * Use this from client components and browser code. Server code should use
 * `@/lib/supabase/server`, which never persists a session to disk and can
 * additionally mint a service-role client for privileged work.
 *
 * Configuration is OPTIONAL. Next.js only inlines `NEXT_PUBLIC_*` values into
 * the browser bundle, so the two variables come from `lib/env-public.ts` (the
 * single place this app reads public env from) rather than `import.meta.env`
 * or a raw `process.env` lookup. With either value missing the app keeps
 * running unchanged and this module throws a readable error only when someone
 * actually asks for a client — a missing Supabase project must never break the
 * existing Prisma-backed product.
 */

let browserClient: SupabaseClient | null = null;

/** Whether both public Supabase values are present. */
export function isSupabaseConfigured(): boolean {
  return Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_URL && publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Lazily create (and memoize) the browser client.
 *
 * The singleton matters: a new client per render would spin up a separate
 * auth/realtime instance for every component and duplicate token refreshes.
 * Session persistence and URL-detection are on because this is the browser
 * client — that is what makes magic-link/OAuth redirects land signed in.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
        "in your .env (see .env.example), then restart the dev server.",
    );
  }
  browserClient ??= createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );
  return browserClient;
}
