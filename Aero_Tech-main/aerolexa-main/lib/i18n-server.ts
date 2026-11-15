/**
 * i18n server resolver — the `next/headers` half of lib/i18n.ts.
 *
 * Split out of lib/i18n.ts so client components ("use client") can import the
 * dictionaries + translate() without dragging `next/headers` into a client
 * bundle (Next.js fails the production build with "You're importing a
 * component that needs next/headers" otherwise — webpack cannot tree-shake a
 * top-level server-only import out of a module graph reached from the client).
 *
 * Server components call `resolveLocale()`; everything else (translate,
 * normalizeLocale, LOCALES) still comes from the shared `lib/i18n.ts`.
 */

import { cookies } from "next/headers";

import { BRAND_STORAGE_KEYS, readBrandCookie } from "@/lib/brand";

import { normalizeLocale, DEFAULT_LOCALE, type LayoutLocaleInput, type Locale } from "./i18n";

/** Resolve the active locale. Priority: ?lang= > cookie > default (en). */
export async function resolveLocale(requested?: string | null): Promise<LayoutLocaleInput> {
  const store = await cookies();
  const fromQuery = normalizeLocale(requested);
  const fromCookie = normalizeLocale(readBrandCookie<string>(store, BRAND_STORAGE_KEYS.locale)?.value);
  return fromQuery ?? fromCookie ?? DEFAULT_LOCALE;
}

export type { Locale };
