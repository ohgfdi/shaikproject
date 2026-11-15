/**
 * Fixed chart & status colour palette shared by chart components and UI
 * badges. These are literal values because ApexCharts/SVG render in canvases
 * that can't read CSS variables — they are chosen for ≥ 4.5:1 contrast against
 * both light and dark surfaces where used as text.
 */
export const CHART = {
  teal: "#5AA8AA",
  amber: "#FFB400",
  violet: "#7C5CFF",
  blue: "#3D9BE9",
  rose: "#E8637A",
  green: "#58B368",
  orange: "#F08A5D",
  lavender: "#B08BBB",
} as const;

export const CHART_PALETTE = Object.values(CHART);

export const SEVERITY = {
  info: { fg: "#3D9BE9", bg: "rgba(61,155,233,0.14)" },
  warning: { fg: "#F08A5D", bg: "rgba(240,138,93,0.16)" },
  critical: { fg: "#E8637A", bg: "rgba(232,99,122,0.16)" },
} as const;

export const CONFIDENCE_LABEL: Record<string, string> = {
  calculated: "Calculated from your data",
  inferred: "Inferred (prototype reasoning)",
  recommendation: "Recommendation (demo logic)",
};

/**
 * Read whether the page currently renders the dark or light theme.
 * Safe during server-side rendering (client components are pre-rendered on the
 * server): no DOM exists there, so the dark default is assumed and the
 * client-only chart wrapper is what actually renders ApexCharts.
 */
export function isDarkTheme(el?: HTMLElement): boolean {
  if (typeof document === "undefined") return true; // SSR: dark is the default theme
  const root = el ?? document.documentElement;
  return !root.classList.contains("light");
}

/** Foreground colour for chart text that matches the active theme. */
export function chartTextColor(): string {
  return isDarkTheme() ? "#C9C9CF" : "#52525B";
}
