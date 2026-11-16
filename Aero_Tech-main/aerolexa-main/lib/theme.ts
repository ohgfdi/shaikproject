import { BRAND_STORAGE_KEYS, brandKey } from "@/lib/brand";

export type ThemeName = "dark" | "light";
export type AccentName = "teal" | "blue" | "violet";

export const THEME_COOKIE = brandKey(BRAND_STORAGE_KEYS.theme);
export const ACCENT_COOKIE = brandKey(BRAND_STORAGE_KEYS.accent);

export const ACCENTS: { value: AccentName; label: string; swatch: string }[] = [
  { value: "teal", label: "Teal", swatch: "#5AA8AA" },
  { value: "blue", label: "Blue", swatch: "#0066FF" },
  { value: "violet", label: "Violet", swatch: "#7C5CFF" },
  { value: "amber", label: "Amber", swatch: "#F5B700" },
  { value: "green", label: "Green", swatch: "#22C55E" },
  { value: "rose", label: "Rose", swatch: "#EC4899" },
];

export function parseTheme(value: string | undefined): ThemeName {
  return value === "light" ? "light" : "dark";
}

export function parseAccent(value: string | undefined): AccentName {
  return value === "blue" || value === "violet" ? value : "teal";
}
