"use client";

/**
 * LocaleProvider — client-side i18n context.
 *
 * The root layout resolves the locale server-side (cookie/query) and passes it
 * down; client components call `useT()` for translated strings. The provider
 * also exposes `setLocale`, which persists the choice to the `aerolexa.locale`
 * cookie and refreshes the server components so the whole tree re-renders in
 * the new locale.
 */

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useTransition } from "react";

import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";
import { translate, type Locale } from "@/lib/i18n";

interface LocaleContextValue {
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (next: Locale) => void;
  /** True while a locale switch is re-rendering server components. */
  pending: boolean;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);
const LocaleContextProvider = LocaleContext.Provider;

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const setLocale = useCallback(
    (next: Locale) => {
      // Persist for one year; SameSite=Lax matches the app's other cookies.
      document.cookie = `${brandKey(BRAND_STORAGE_KEYS.locale)}=${next}; path=/; max-age=31536000; samesite=lax`;
      startTransition(() => router.refresh());
    },
    [router],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      t: (key, vars) => translate(locale, key, vars),
      setLocale,
      pending,
    }),
    [locale, setLocale, pending],
  );

  return <LocaleContextProvider value={value}>{children}</LocaleContextProvider>;
}

/** Access the active locale + translator. Throws when used outside the provider. */
export function useT(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useT must be used inside <LocaleProvider>");
  return ctx;
}

/** True while a locale switch is re-rendering server components. */
export function useLocalePending(): boolean {
  return useT().pending;
}
