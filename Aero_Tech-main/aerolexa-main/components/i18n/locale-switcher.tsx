"use client";

/**
 * LocaleSwitcher — compact control for switching English / हिन्दी / اردو.
 *
 * Coverage is deliberately stated in the option labels: `en` is the language the
 * product is written in; `hi` and `ur` translate the shared strings that call
 * `t()` (auth, common actions, empty/error copy) but not every page. Labelling
 * them "partial" is the honest option — showing "हिन्दी" alone implied a fully
 * translated product that does not exist yet.
 *
 * Switching persists to the `ledgerly.locale` cookie and refreshes server
 * components. The default is English (lib/i18n.ts), matching the copy.
 */

import { Globe } from "lucide-react";

import { useT } from "@/components/i18n/locale-provider";
import { LOCALES, type Locale } from "@/lib/i18n";

const LABELS: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी (partial)",
  ur: "اردو (partial)",
};

export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useT();

  return (
    <label className={`inline-flex items-center gap-1.5 text-caption text-muted ${className}`}>
      <Globe aria-hidden className="size-4" />
      <span className="sr-only">Language</span>
      <select
        aria-label="Language"
        title="English is the product language. Hindi and Urdu currently cover shared interface strings only."
        className="min-h-9 cursor-pointer rounded-md border border-line bg-transparent px-1.5 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
