import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Collision-resistant id for client-side keys. */
export function uid(prefix = ""): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}-${rnd}` : rnd;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Robust numeric parse: handles "1,234.5", "12%", "€ 42", null → NaN. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  const str = String(value).trim();
  if (str === "") return Number.NaN;
  const cleaned = str.replace(/[$€£¥,\s]/g, "").replace(/[()]/g, (m) => (m === "(" ? "-" : ""));
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function isNumericString(value: unknown): boolean {
  return Number.isFinite(toNumber(value));
}

/**
 * Relative luminance of an sRGB hex colour (0–1). Used to pick text colours
 * that meet WCAG AA contrast on the given background.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return 0;
  const channel = (offset: number) => {
    const int = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return int <= 0.04045 ? int / 12.92 : Math.pow((int + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Black or white — whichever meets ≥ 4.5:1 against the given background colour. */
export function readableTextOn(hex: string): string {
  const l = relativeLuminance(hex);
  // Contrast of pure white vs background…
  const white = 1.05 / (l + 0.05);
  // …and pure black vs background.
  const black = (l + 0.05) / 0.05;
  return white >= black && white >= 4.5 ? "#FFFFFF" : "#000000";
}

/** Deterministic small-string hash (stable across processes). */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a colour from a fixed accessible palette by stable hash (charts/avatars). */
const PALETTE = ["#5AA8AA", "#FFB400", "#7C5CFF", "#3D9BE9", "#E8637A", "#58B368", "#F08A5D", "#B08BBB"];
export function colourFor(seed: string, index = 0): string {
  return PALETTE[(hashString(seed) + index) % PALETTE.length] ?? PALETTE[0] ?? "#5AA8AA";
}

export function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
