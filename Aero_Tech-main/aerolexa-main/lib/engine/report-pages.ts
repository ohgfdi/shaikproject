/**
 * Report pages + bookmarks + themes (pure, serializable).
 *
 * Power BI parity for the report canvas:
 *   - Pages: a dashboard (report) is a list of named pages; page 0 mirrors
 *     the pre-pages `widgets` array so every existing dashboard upgrades in
 *     place with no data migration.
 *   - Bookmarks: a named snapshot of one page's cross-filter + slicer
 *     selections (the report's view state), captured and recalled in one
 *     click. Only serializable state is captured.
 *   - Themes: a palette + chart-formatting preset applied to every visual.
 *     Only the honest subset the ECharts suite can actually render.
 *
 * Pure functions over serializable types — hand-computable, no browser.
 */

import type { ReportPage, ReportTheme } from "@/lib/types";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Build the default page list for a dashboard that has no pages yet. */
export function ensurePages(dashboard: { title: string; widgets: unknown[]; pages?: unknown }): ReportPage[] {
  if (Array.isArray(dashboard.pages) && dashboard.pages.length > 0) {
    return dashboard.pages as ReportPage[];
  }
  return [{ id: "page-1", name: dashboard.title || "Page 1", widgets: dashboard.widgets as never[] }];
}

/** Add a page (unique id, unique name). */
export function addPage(pages: ReportPage[], name: string): ReportPage[] {
  const clean = name.trim();
  if (!clean) throw new Error("A page needs a name.");
  if (pages.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`A page named “${clean}” already exists.`);
  }
  let n = pages.length + 1;
  let id = `page-${n}`;
  const ids = new Set(pages.map((p) => p.id));
  while (ids.has(id)) id = `page-${++n}`;
  return [...pages, { id, name: clean, widgets: [] }];
}

/** Rename a page (keeps uniqueness, case-insensitive). */
export function renamePage(pages: ReportPage[], pageId: string, name: string): ReportPage[] {
  const clean = name.trim();
  if (!clean) throw new Error("A page needs a name.");
  const clash = pages.find((p) => p.id !== pageId && p.name.toLowerCase() === clean.toLowerCase());
  if (clash) throw new Error(`A page named “${clean}” already exists.`);
  return pages.map((p) => (p.id === pageId ? { ...p, name: clean } : p));
}

/** Remove a page; refuses to remove the last one (a report is never pageless). */
export function removePage(pages: ReportPage[], pageId: string): ReportPage[] {
  if (pages.length <= 1) throw new Error("A report needs at least one page.");
  if (!pages.some((p) => p.id === pageId)) return pages;
  return pages.filter((p) => p.id !== pageId);
}

/** Reorder pages (drag in the page tabs bar). */
export function movePage(pages: ReportPage[], from: number, to: number): ReportPage[] {
  const next = [...pages];
  const [item] = next.splice(from, 1);
  if (!item) return pages;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

/**
 * Capture a bookmark: a named snapshot of the page's current filter/view
 * state. Serializable only — no widget payloads, just the view state.
 */
export function captureBookmark(
  name: string,
  selections: { column: string; values: string[]; sourceWidgetId: string; sourceWidgetTitle?: string }[],
  opts?: { pageId?: string; description?: string },
) {
  const clean = name.trim();
  if (!clean) throw new Error("A bookmark needs a name.");
  return {
    id: `bm-${Math.random().toString(36).slice(2, 10)}`,
    name: clean,
    pageId: opts?.pageId,
    description: opts?.description,
    filters: selections.map((s) => ({ ...s })),
    capturedAt: new Date().toISOString(),
  };
}

/** Toggle-sort bookmarks alphabetically for the bookmarks pane (stable). */
export function sortBookmarks<T extends { name: string }>(bookmarks: T[]): T[] {
  return [...bookmarks].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** The default theme — matches the app's own accents (used when none set). */
export const DEFAULT_THEME: ReportTheme = {
  name: "Ledgerly",
  background: "#ffffff",
  foreground: "#0A0A0A",
  palette: ["#5AA8AA", "#FFB400", "#2e7d32", "#c62828", "#5c6bc0", "#00897b", "#f4511e", "#6d4c41"],
  dataLabels: false,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Parse a Power BI-style JSON theme. Accepts the honest subset:
 * { name?, background?, foreground?, dataLabels?, palette | dataColors: [...] }
 * Throws with an actionable message for anything it cannot honor — a theme
 * that would be silently ignored is worse than no theme.
 */
export function parseTheme(json: string): ReportTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Theme is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Theme must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const rawColors = Array.isArray(obj.palette) ? obj.palette : Array.isArray(obj.dataColors) ? obj.dataColors : null;
  if (!rawColors || rawColors.length === 0) {
    throw new Error('Theme needs a non-empty "palette" (or "dataColors") array of hex colors.');
  }
  if (rawColors.length < 2) throw new Error("Theme palette needs at least 2 colors.");
  if (rawColors.length > 24) throw new Error("Theme palette is capped at 24 colors.");
  const palette = rawColors.map((c) => {
    if (typeof c !== "string" || !HEX.test(c)) {
      throw new Error(`“${String(c)}” is not a #rrggbb hex color.`);
    }
    return c.toLowerCase();
  });
  const background =
    typeof obj.background === "string" && HEX.test(obj.background)
      ? obj.background.toLowerCase()
      : DEFAULT_THEME.background;
  const foreground =
    typeof obj.foreground === "string" && HEX.test(obj.foreground)
      ? obj.foreground.toLowerCase()
      : DEFAULT_THEME.foreground;
  return {
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 80) : "Custom theme",
    background,
    foreground,
    palette,
    dataLabels: obj.dataLabels === true,
  };
}

/**
 * Apply a theme to one page's widgets: palette overrides each PBI visual's
 * palette and chart widgets' per-widget format, and dataLabels turns on
 * labels everywhere the renderer supports them.
 */
export function applyThemeToPages(pages: ReportPage[], theme: ReportTheme): ReportPage[] {
  return pages.map((page) => ({
    ...page,
    widgets: page.widgets.map((w) => {
      const fmt = {
        ...(w.format ?? {}),
        ...(theme.palette.length ? { palette: theme.palette } : {}),
        ...(theme.dataLabels ? { dataLabels: true } : {}),
      };
      return {
        ...w,
        format: fmt,
        ...(w.pbiVisual
          ? {
              pbiVisual: {
                ...w.pbiVisual,
                format: {
                  ...(w.pbiVisual.format ?? {}),
                  palette: theme.palette,
                  ...(theme.dataLabels ? { dataLabels: true } : {}),
                },
              },
            }
          : {}),
      };
    }),
  }));
}
