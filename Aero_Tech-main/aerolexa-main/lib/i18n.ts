/**
 * i18n — lightweight, dependency-free internationalization scaffold (shared half).
 *
 * `en` (default and fallback), `hi` and `ur` (RTL — Urdu) ship in-repo. The
 * product copy is written in English and only the shared strings that call
 * `t()` are translated, so English is the default; a non-English dictionary is
 * partial coverage rather than a translated product. Override per visitor via
 * the `ledgerly.locale` cookie or ?lang= query param.
 *
 * Design rules (see ROADMAP 7.5):
 * - No runtime network fetches; dictionaries are static imports so bundles stay
 *   deterministic and testable.
 * - `t()` interpolates {placeholders} — no ICU dependency, covers current needs.
 * - Missing keys fall back to English, then to the key itself (never crashes).
 * - RTL: `isRtl()` drives the <html dir> attribute in the root layout; every
 *   locale declares its direction in one place (RTL_SAFE_LOCALES).
 * - Server components read the locale from cookies via lib/i18n-server.ts (the
 *   `next/headers` half); client components consume the `LocaleProvider`
 *   context. Both resolve through the same dictionary.
 */

export const LOCALES = ["en", "hi", "ur"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Locales that render right-to-left; the root layout sets <html dir> from this. */
export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ur"]);

/** True when the locale lays out right-to-left. */
export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

/** The `dir` attribute value for a locale ("ltr" | "rtl"). */
export function dirFor(locale: Locale): "ltr" | "rtl" {
  return isRtl(locale) ? "rtl" : "ltr";
}

import en from "./locales/en";
import hi from "./locales/hi";
import ur from "./locales/ur";

const DICTIONARIES: Record<Locale, Record<string, string>> = { en, hi, ur };

/** Normalize arbitrary input to a supported locale, or null. */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.startsWith("hi")) return "hi";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("ur")) return "ur";
  return null;
}

/** Translate a key in the given locale with {placeholder} interpolation. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES.en;
  let out = dict[key] ?? DICTIONARIES.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

/** Build a bound translator for one locale (convenience for server components). */
export function getTranslator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
}

/** Type used by the root layout to set <html lang>. */
export type LayoutLocaleInput = Locale;
