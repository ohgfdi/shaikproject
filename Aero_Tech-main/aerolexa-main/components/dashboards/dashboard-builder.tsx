"use client";

import { Copy, Download, GripVertical, PencilRuler, Plus, Save, Trash2, X, ArrowUpRight } from "lucide-react";
import { Filter, Search } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { ChartRenderer } from "@/components/charts/chart";
import type { PbiVisualKind } from "@/components/charts/pbi-visual";
import { useDashboardCollab } from "@/components/dashboard/use-dashboard-collab";
import { DashboardCopilot } from "@/components/dashboards/dashboard-copilot";
import { useDashboardPresence, type PresencePeer } from "@/components/dashboards/use-presence";
import { InsightCardView } from "@/components/insight/insight-card";
import { PivotCell } from "@/components/pivot/pivot-cell";
import { PivotFieldBuilder } from "@/components/pivot/pivot-field-builder";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { ErrorMessage } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Card, Badge } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/client/api";
import { applyRemoteWidgets, widgetsToOps } from "@/lib/collab/dashboard-widget-sync";
import {
  applyCrossFilters,
  buildDrillThrough,
  toggleSelection,
  widgetCategories,
  type CrossFilterSelection,
  type DrillThroughResult,
} from "@/lib/engine/cross-filter";
import { drillThroughUrl } from "@/lib/engine/drill-through";
import { emptyFieldState, type PivotField, type PivotFieldState } from "@/lib/engine/pivot-grid";
import {
  addPage,
  captureBookmark,
  movePage,
  parseTheme,
  removePage,
  renamePage,
  sortBookmarks,
} from "@/lib/engine/report-pages";
import { buildSlicer, toggleSlicerValue } from "@/lib/engine/slicer";
import { buildMapSpec, buildPbiSpec, detectMapScope, VISUAL_PICKER_OPTIONS } from "@/lib/engine/visual-picker";
import type {
  AnalysisResult,
  DashboardWidget,
  InsightCard,
  ReportBookmark,
  ReportPage,
  ReportTheme,
} from "@/lib/types";
import { cn, uid } from "@/lib/utils";

export interface WidgetSourceAnalysis {
  id: string;
  title: string;
  kind: string;
  result: AnalysisResult | null;
}

export interface DashboardEditorProps {
  dashboardId: string;
  title: string;
  projectId: string | null;
  initialWidgets: DashboardWidget[];
  initialPages?: ReportPage[];
  initialBookmarks?: ReportBookmark[];
  initialTheme?: ReportTheme | null;
  analyses: WidgetSourceAnalysis[];
  insights: InsightCard[];
  isDemo: boolean;
  numStyle?: "comma" | "dot" | "plain";
}

type AddKind = "chart" | "table" | "kpi" | "pivot" | "insight" | "text" | "recommendation" | "pbi" | "slicer" | "map";

export function DashboardBuilder(props: DashboardEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [title, setTitle] = useState(props.title);
  // ---- Report pages (Power BI multi-page report) ---------------------------
  const [pages, setPages] = useState<ReportPage[]>(
    () => props.initialPages ?? [{ id: "page-1", name: props.title, widgets: props.initialWidgets }],
  );
  const [activePageId, setActivePageId] = useState<string>(() => pages[0]?.id ?? "page-1");
  // ---- Bookmarks (named view states) ---------------------------------------
  const [bookmarks, setBookmarks] = useState<ReportBookmark[]>(() => props.initialBookmarks ?? []);
  const [bookmarkName, setBookmarkName] = useState("");
  const [bookmarkPaneOpen, setBookmarkPaneOpen] = useState(false);
  // ---- Theme (report-wide palette/format preset) ----------------------------
  const [theme, setTheme] = useState<ReportTheme | null>(() => props.initialTheme ?? null);
  const [themeJson, setThemeJson] = useState("");
  const [themeError, setThemeError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // ---- Active page: its widgets ARE the editing surface ---------------------
  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0]!;
  const setActiveWidgets = (updater: (ws: DashboardWidget[]) => DashboardWidget[]) => {
    setPages((ps) => ps.map((p) => (p.id === activePage.id ? { ...p, widgets: updater(p.widgets) } : p)));
  };

  /** Always-current widgets for code that must not capture stale state (slicer builder). */
  const widgetsLive = useRef<DashboardWidget[]>(props.initialWidgets);
  widgetsLive.current = activePage.widgets;
  useEffect(() => {
    widgetsLive.current = activePage.widgets;
  }, [activePage.widgets]);

  // ---- Cross-filtering (Power BI click-to-filter) + drill-through ----------
  const [selections, setSelections] = useState<CrossFilterSelection[]>(() => {
    // Restore selections saved with the dashboard (first widget that carries them).
    const saved = props.initialWidgets.find((w) => w.crossFilters?.length)?.crossFilters ?? [];
    return saved.map((s) => ({ ...s }));
  });
  const [drill, setDrill] = useState<DrillThroughResult | null>(null);
  /** Shareable row-level detail URL for the current drill (null when the widget has no dataset). */
  const [drillUrl, setDrillUrl] = useState<string | null>(null);

  // ---- Realtime co-editing (ROADMAP 7.2): Yjs CRDT widget sync -------------
  // Remote widget states fold into the active page (last-writer-wins per
  // widget via CRDT versions); local edits diff into room ops. Presence
  // (avatars + per-widget focus) continues via the lightweight SSE hook.
  const collab = useDashboardCollab(props.dashboardId, true);
  const collabRef = useRef(collab);
  collabRef.current = collab;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const activePageIdRef = useRef(activePageId);
  activePageIdRef.current = activePage.id;
  /** Widgets already applied from the room — suppresses op echo loops. */
  const lastAppliedVersionRef = useRef<Map<string, number>>(new Map());
  /** Guards against re-entrant setState during the fold. */
  const foldingRef = useRef(false);

  // Fold remote widget states into the active page whenever the room changes.
  useEffect(() => {
    if (collab.widgets.length === 0 || foldingRef.current) return;
    // Skip when nothing new: every remote widget at a version we already applied.
    const anyNew = collab.widgets.some((r) => (lastAppliedVersionRef.current.get(r.widgetId) ?? -1) < r.version);
    if (!anyNew) return;
    foldingRef.current = true;
    try {
      setPages((ps) => {
        const next = applyRemoteWidgets(collab.widgets, ps, activePageIdRef.current);
        if (next === ps) return ps;
        for (const r of collab.widgets) lastAppliedVersionRef.current.set(r.widgetId, r.version);
        return next;
      });
    } finally {
      foldingRef.current = false;
    }
  }, [collab.widgets]);

  /** Diff a page's widgets into room ops and push them (fire-and-forget). */
  const pushPageOps = (widgets: DashboardWidget[]) => {
    const c = collabRef.current;
    if (!c.connected || c.role === "viewer") return;
    const remote = new Map<string, { type: string; spec: Record<string, unknown>; version: number }>();
    for (const r of c.widgets) remote.set(r.widgetId, r);
    for (const op of widgetsToOps(widgets, remote, c.widgetOrder)) {
      switch (op.type) {
        case "add":
          c.addWidget({ widgetId: op.widgetId, type: op.widgetType, spec: op.spec, version: 1 });
          break;
        case "set":
          c.pushWidgetSpec(op.widgetId, op.widgetType, op.spec);
          break;
        case "merge":
          c.mergeWidgetSpec(op.widgetId, op.spec);
          break;
        case "remove":
          c.removeWidget(op.widgetId);
          break;
        case "reorder":
          c.reorderWidgets(op.order);
          break;
      }
    }
  };

  /** Run a local widget mutation AND mirror it into the room. */
  const mutateWidgets = (updater: (ws: DashboardWidget[]) => DashboardWidget[]) => {
    setActiveWidgets((ws) => {
      const next = updater(ws);
      pushPageOps(next);
      return next;
    });
  };

  // ---- Realtime presence (ROADMAP 7.2): who else is on this dashboard ------
  const presence = useDashboardPresence(props.dashboardId, true);
  /** Map of widgetId -> peers focused on it, for the live cursor badges. */
  const peersByWidget = new Map<string, PresencePeer[]>();
  for (const p of presence.peers) {
    if (!p.widgetId) continue;
    const list = peersByWidget.get(p.widgetId) ?? [];
    list.push(p);
    peersByWidget.set(p.widgetId, list);
  }
  /** Report the widget this user is focused on (drives peers' cursor badges). */
  const reportFocus = (widgetId: string | undefined) => presence.setWidget(widgetId);
  const presenceBar =
    presence.peers.length > 0 ? (
      <div className="flex items-center gap-1" aria-label={`${presence.peers.length} other viewer(s) online`}>
        {presence.peers.slice(0, 5).map((p) => (
          <span
            key={p.id}
            title={`${p.name}${p.widgetId ? " · viewing a widget" : ""}`}
            className="inline-flex size-6 items-center justify-center rounded-full text-[10px] font-bold text-black ring-2 ring-background"
            style={{ backgroundColor: p.color }}
          >
            {(p.name || "?").slice(0, 1).toUpperCase()}
          </span>
        ))}
        {presence.peers.length > 5 && <span className="text-caption text-muted">+{presence.peers.length - 5}</span>}
      </div>
    ) : null;

  /** CRDT co-editing status chip: shows when the room is live ( editors besides presence). */
  const collabChip =
    collab.connected && collab.peers.length > 0 ? (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-caption text-foreground"
        title={`Co-editing live — ${collab.peers.length} collaborator(s) connected`}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-accent" />
        co-editing · {collab.peers.length}
      </span>
    ) : null;

  const onPageAdd = () => {
    const name = `Page ${pages.length + 1}`;
    try {
      setPages((ps) => addPage(ps, name));
      setActivePageId(`page-${pages.length + 1}`);
    } catch {
      // name collision fallback: page-N uniqueness handled by addPage ids
      setPages((ps) => addPage(ps, `${name} (new)`));
    }
  };
  const onPageRename = (pageId: string, name: string) => {
    try {
      setPages((ps) => renamePage(ps, pageId, name));
    } catch (err) {
      toast({ title: "Could not rename page", message: errorMessage(err), type: "error" });
    }
  };
  const onPageRemove = async (pageId: string) => {
    const page = pages.find((p) => p.id === pageId);
    const ok = await confirm({
      title: `Delete page “${page?.name ?? ""}”?`,
      message: "Its widgets will be removed permanently.",
      confirmLabel: "Delete page",
    });
    if (!ok) return;
    try {
      setPages((ps) => {
        const next = removePage(ps, pageId);
        return next;
      });
      if (activePageId === pageId) {
        const remaining = pages.filter((p) => p.id !== pageId);
        setActivePageId(remaining[0]?.id ?? "page-1");
      }
    } catch (err) {
      toast({ title: "Could not delete page", message: errorMessage(err), type: "error" });
    }
  };

  // ---- Bookmarks ------------------------------------------------------------
  const captureCurrentBookmark = () => {
    const name = bookmarkName.trim() || `Bookmark ${bookmarks.length + 1}`;
    try {
      const bm = captureBookmark(name, selections, { pageId: activePage.id });
      setBookmarks((bs) => sortBookmarks([...bs, bm]));
      setBookmarkName("");
      toast({ title: "Bookmark captured", message: `“${bm.name}” recalls the current filters.`, type: "success" });
    } catch (err) {
      toast({ title: "Could not capture bookmark", message: errorMessage(err), type: "error" });
    }
  };
  const applyBookmark = (bm: ReportBookmark) => {
    setSelections(bm.filters.map((f) => ({ ...f })));
    if (bm.pageId && pages.some((p) => p.id === bm.pageId)) setActivePageId(bm.pageId);
    // Restore slicer selections that belong to this bookmark.
    const nextSlicer: Record<string, string[]> = { ...slicerState };
    for (const f of bm.filters) {
      if (pages.some((p) => p.widgets.some((w) => w.id === f.sourceWidgetId && w.type === "slicer"))) {
        nextSlicer[f.sourceWidgetId] = f.values;
      }
    }
    setSlicerState(nextSlicer);
  };

  // ---- Theme -----------------------------------------------------------------
  const applyTheme = () => {
    try {
      const parsed = parseTheme(themeJson);
      setTheme(parsed);
      setPages((ps) => ps.map((p) => ({ ...p, widgets: p.widgets.map((w) => ({ ...w })) })));
      setThemeError(null);
      toast({
        title: "Theme applied",
        message: `“${parsed.name}” — ${parsed.palette.length} colors. Remember to save.`,
        type: "success",
      });
    } catch (err) {
      setThemeError(errorMessage(err));
    }
  };

  // ---- Slicers (Power BI filter visuals): per-slicer selection state --------
  const [slicerState, setSlicerState] = useState<Record<string, string[]>>(() => {
    const saved = props.initialWidgets.find((w) => w.crossFilters?.length)?.crossFilters ?? [];
    const init: Record<string, string[]> = {};
    for (const w of props.initialWidgets) {
      const spec = w.type === "slicer" ? w.slicer : undefined;
      if (spec) {
        init[w.id] = saved.find((f) => f.sourceWidgetId === w.id && f.column === spec.column)?.values ?? [];
      }
    }
    return init;
  });

  /** Slicer value clicked: update its state, then project ALL slicers into the selection set. */
  const onSlicerToggle = (w: DashboardWidget, value: string) => {
    if (!w.slicer) return;
    const multi = w.slicer.multiSelect ?? true;
    const nextSelected = toggleSlicerValue(slicerState[w.id] ?? [], value, multi);
    setSlicerState((prev) => ({ ...prev, [w.id]: nextSelected }));
    setSelections((current) => {
      // Re-project every slicer's current contribution (other slicers keep theirs).
      const withoutSlicers = current.filter((s) => {
        const sw = pages.flatMap((p) => p.widgets).find((x) => x.id === s.sourceWidgetId);
        return sw?.type !== "slicer";
      });
      const projected: CrossFilterSelection[] = [];
      for (const x of pages.flatMap((p) => p.widgets)) {
        if (x.type !== "slicer" || !x.slicer) continue;
        const selected = x.id === w.id ? nextSelected : (slicerState[x.id] ?? []);
        if (selected.length === 0) continue;
        projected.push({
          column: x.slicer.column,
          values: selected,
          sourceWidgetId: x.id,
          sourceWidgetTitle: "Slicer",
        });
      }
      return [...withoutSlicers, ...projected];
    });
  };

  /** Click a tile's data point: toggle it as the cross-filter (or open drill-through with shift). */
  const onTileClick = (w: DashboardWidget, value: string, opts?: { drill?: boolean }) => {
    if (opts?.drill) {
      const d = buildDrillThrough(w, value);
      if (d) {
        // The shareable row-level detail URL (lib/engine/drill-through.ts):
        // /datasets/[id]/detail re-runs the same filter over the dataset's
        // real rows through the RLS chokepoint. Only offered when the widget
        // carries its source dataset — snapshot-only widgets still drill via
        // the honest per-series breakdown below.
        setDrillUrl(
          w.datasetId && d.column
            ? drillThroughUrl({
                datasetId: w.datasetId,
                filters: [{ column: d.column, value: d.value }],
                sourceWidget: { id: w.id, title: w.title, kind: w.type },
              })
            : null,
        );
        setDrill(d);
      }
      return;
    }
    const { column } = widgetCategories(w);
    setSelections((sel) =>
      toggleSelection(sel, { column, values: [value], sourceWidgetId: w.id, sourceWidgetTitle: w.title }),
    );
  };

  const clearFilters = () => setSelections([]);

  const saveFiltersWithDashboard = async () => {
    // Persist the active selections on the first widget of the ACTIVE page.
    if (!activePage.widgets.length) return;
    const withMeta: DashboardWidget[] = activePage.widgets.map((w, i) =>
      i === 0 ? { ...w, crossFilters: selections.length ? selections : undefined } : w,
    );
    pushPageOps(withMeta);
    setPages((ps) => ps.map((p) => (p.id === activePage.id ? { ...p, widgets: withMeta } : p)));
    await api(`/api/dashboards/${props.dashboardId}`, {
      method: "PATCH",
      body: JSON.stringify({ pages: pages.map((p) => (p.id === activePage.id ? { ...p, widgets: withMeta } : p)) }),
    });
  };

  const visibleWidgets = applyCrossFilters(activePage.widgets, selections);

  const update = (id: string, patch: Partial<DashboardWidget>) =>
    mutateWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));

  const remove = (id: string) => mutateWidgets((ws) => ws.filter((w) => w.id !== id));

  const move = (from: number, to: number) =>
    mutateWidgets((ws) => {
      const next = [...ws];
      const [item] = next.splice(from, 1);
      if (!item) return ws;
      next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/dashboards/${props.dashboardId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          pages,
          bookmarks,
          theme,
          // Keep the legacy widgets column in sync with page 1 so older
          // readers (published apps) render the first page unchanged.
          widgets: pages[0]?.widgets ?? [],
        }),
      });
      toast({
        title: "Dashboard saved",
        message: `${pages.length} page(s), ${bookmarks.length} bookmark(s) snapshot to your data.`,
        type: "success",
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const [exporting, setExporting] = useState(false);
  /**
   * Render the dashboard server-side to PDF via the headless-browser render
   * route (RENDERING_ENABLED). Downloads the binary response directly.
   */
  const exportDashboard = async () => {
    setExporting(true);
    try {
      const res = await fetch(`/api/dashboards/${props.dashboardId}/render?format=pdf&theme=light&fullPage=true`);
      if (!res.ok) {
        // The route returns a plain-text message for 403/404/400 — surface it.
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Export failed (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(title || "dashboard").replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "dashboard"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "PDF exported", message: "The dashboard was rendered and downloaded.", type: "success" });
    } catch (err) {
      toast({
        title: "Could not export PDF",
        message: err instanceof Error ? err.message : "Rendering may be disabled on this server (RENDERING_ENABLED).",
        type: "error",
      });
    } finally {
      setExporting(false);
    }
  };

  const duplicate = async () => {
    try {
      const res = await api<{ dashboard: { id: string } }>(`/api/dashboards/${props.dashboardId}/duplicate`, {
        method: "POST",
      });
      toast({ title: "Dashboard duplicated", type: "success" });
      router.push(`/dashboards/${res.dashboard.id}`);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not duplicate", message: errorMessage(err), type: "error" });
    }
  };

  const removeDashboard = async () => {
    const ok = await confirm({
      title: "Delete this dashboard?",
      message: "All tiles and layout for this dashboard will be removed permanently.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/dashboards/${props.dashboardId}`, { method: "DELETE" });
      router.push(props.projectId ? `/projects/${props.projectId}?tab=dashboards` : "/projects");
      router.refresh();
    } catch (err) {
      toast({ title: "Could not delete", message: errorMessage(err), type: "error" });
    }
  };

  return (
    <div>
      {error && <ErrorMessage title="Save failed" message={error} className="mb-4" />}
      {/* A1 — dashboard copilot: answers about the page as currently filtered. */}
      <DashboardCopilot
        dashboardId={props.dashboardId}
        pageId={activePage.id}
        crossFilters={selections.map((s) => ({ column: s.column, values: s.values }))}
      />
      <div className="mb-4 mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {editMode ? (
            <input
              aria-label="Dashboard title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full max-w-md rounded-md border border-line bg-surface px-2.5 py-1.5 text-h1 text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          ) : (
            <h1 className="text-h1 text-foreground">{title}</h1>
          )}
          <p className="mt-1 text-caption text-muted">
            {pages.length} page(s) · {activePage.widgets.length} widget(s) on this page · every widget holds a snapshot
            computed from your dataset
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {collabChip}
          {presenceBar}
          {editMode ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAddOpen(true)}
                icon={<Plus aria-hidden className="size-4" />}
              >
                Add widget
              </Button>
              <Button variant="secondary" size="sm" onClick={duplicate} icon={<Copy aria-hidden className="size-4" />}>
                Duplicate
              </Button>
              <Button size="sm" onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
                Save dashboard
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={saveFiltersWithDashboard}
                icon={<Search aria-hidden className="size-4" />}
                title="Persist the active cross-filter selections with the dashboard"
              >
                Save filters
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}>
                Preview
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={duplicate} icon={<Copy aria-hidden className="size-4" />}>
                Duplicate
              </Button>
              <Button size="sm" onClick={() => setEditMode(true)} icon={<PencilRuler aria-hidden className="size-4" />}>
                Edit canvas
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={exportDashboard}
                loading={exporting}
                icon={<Download aria-hidden className="size-4" />}
                title="Render this dashboard to PDF (headless browser)"
              >
                Export PDF
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBookmarkPaneOpen((v) => !v)}
            title="Bookmarks: capture and recall named filter view states"
          >
            Bookmarks ({bookmarks.length})
          </Button>
          <Button variant="danger" size="sm" onClick={removeDashboard} icon={<Trash2 aria-hidden className="size-4" />}>
            Delete
          </Button>
        </div>
      </div>

      {/* ---- Page tabs (Power BI report pages) ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Report pages">
        {pages.map((p, i) => (
          <div key={p.id} className="flex items-center">
            {editMode ? (
              <input
                aria-label={`Page ${i + 1} name`}
                value={p.name}
                onChange={(e) => onPageRename(p.id, e.target.value)}
                className="w-28 rounded-t-md border-b-2 px-2 py-1 text-caption focus:outline-none"
                style={{
                  borderBottomColor: p.id === activePageId ? "var(--accent)" : "var(--line)",
                  color: p.id === activePageId ? "var(--foreground)" : "var(--muted)",
                }}
              />
            ) : (
              <button
                role="tab"
                aria-selected={p.id === activePageId}
                onClick={() => setActivePageId(p.id)}
                className="rounded-t-md border-b-2 px-3 py-1 text-caption"
                style={{
                  borderBottomColor: p.id === activePageId ? "var(--accent)" : "var(--line)",
                  color: p.id === activePageId ? "var(--foreground)" : "var(--muted)",
                }}
              >
                {p.name}
              </button>
            )}
            {editMode && pages.length > 1 && (
              <button
                aria-label={`Delete page ${p.name}`}
                onClick={() => onPageRemove(p.id)}
                className="ml-0.5 rounded p-0.5 text-muted hover:text-danger"
              >
                <X aria-hidden className="size-3" />
              </button>
            )}
          </div>
        ))}
        {editMode && (
          <Button variant="ghost" size="sm" onClick={onPageAdd} icon={<Plus aria-hidden className="size-3.5" />}>
            Add page
          </Button>
        )}
      </div>

      {/* Page reorder (drag-free, arrow controls) */}
      {editMode && pages.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-muted">Reorder:</span>
          {pages.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1 rounded border border-line px-2 py-0.5 text-caption">
              {p.name}
              <button
                aria-label={`Move ${p.name} left`}
                disabled={i === 0}
                onClick={() => setPages((ps) => movePage(ps, i, i - 1))}
                className="disabled:opacity-30"
              >
                ←
              </button>
              <button
                aria-label={`Move ${p.name} right`}
                disabled={i === pages.length - 1}
                onClick={() => setPages((ps) => movePage(ps, i, i + 1))}
                className="disabled:opacity-30"
              >
                →
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ---- Bookmarks pane ---- */}
      {bookmarkPaneOpen && (
        <div className="mb-3 rounded-md border border-line bg-surface p-3">
          <p className="text-sm font-medium text-foreground">Bookmarks — named filter view states</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              aria-label="Bookmark name"
              value={bookmarkName}
              onChange={(e) => setBookmarkName(e.target.value)}
              placeholder="Name this view state…"
              className="h-8 w-48 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
            <Button size="sm" variant="secondary" onClick={captureCurrentBookmark}>
              Capture current filters
            </Button>
          </div>
          {bookmarks.length === 0 ? (
            <p className="mt-2 text-caption text-muted">
              No bookmarks yet. Set slicers/cross-filters, name the state, and capture it — one click recalls it.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {bookmarks.map((bm) => (
                <li key={bm.id} className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => applyBookmark(bm)}
                    className="rounded border border-line px-2 py-0.5 text-caption text-foreground hover:border-accent hover:bg-accent/10"
                    title={bm.description ?? `Captured ${new Date(bm.capturedAt).toLocaleString()}`}
                  >
                    Apply “{bm.name}”
                  </button>
                  <span className="text-caption text-muted">
                    {bm.filters.length
                      ? bm.filters.map((f) => `${f.column}: ${f.values.join(", ")}`).join(" · ")
                      : "(no filters)"}
                  </span>
                  <button
                    aria-label={`Delete bookmark ${bm.name}`}
                    onClick={() => setBookmarks((bs) => bs.filter((b) => b.id !== bm.id))}
                    className="text-muted hover:text-danger"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---- Theme editor ---- */}
      {editMode && (
        <details className="mb-3 rounded-md border border-line bg-surface px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Report theme {theme ? `· ${theme.name} (${theme.palette.length} colors)` : ""}
          </summary>
          <p className="mt-2 text-caption text-muted">
            Paste a Power BI-style theme JSON (palette/dataColors + optional background, foreground, dataLabels). Every
            renderer-honored color is applied to the whole report.
          </p>
          <textarea
            aria-label="Theme JSON"
            value={themeJson}
            onChange={(e) => setThemeJson(e.target.value)}
            rows={4}
            placeholder={'{"name":"Corporate","dataColors":["#5AA8AA","#FFB400"],"dataLabels":true}'}
            className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
          {themeError && <p className="mt-1 text-caption text-danger">{themeError}</p>}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={applyTheme} disabled={!themeJson.trim()}>
              Apply theme
            </Button>
            {theme && (
              <Button size="sm" variant="ghost" onClick={() => setTheme(null)}>
                Reset to default
              </Button>
            )}
          </div>
        </details>
      )}

      {activePage.widgets.length === 0 ? (
        <Card>
          <div className="px-4 py-14 text-center">
            <p className="font-medium text-foreground">This canvas is empty</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Add a chart from your analyses, an insight card or a note. Widgets keep working snapshots of your real
              numbers.
            </p>
            {editMode && (
              <Button className="mt-4" onClick={() => setAddOpen(true)} icon={<Plus aria-hidden className="size-4" />}>
                Add your first widget
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <>
          {/* Active cross-filter chips (Power BI "filtered by" bar) */}
          {selections.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/50 px-3 py-2">
              <Filter aria-hidden className="size-4 text-accent" />
              <span className="text-caption font-medium text-foreground">Filtered by</span>
              {selections.map((s) => (
                <Badge key={`${s.sourceWidgetId}:${s.column}`} variant="info" className="gap-1">
                  {s.column}: {s.values.join(", ")}
                </Badge>
              ))}
              <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto">
                Clear filters
              </Button>
            </div>
          )}
          <div className="grid grid-cols-12 gap-3">
            {visibleWidgets.map((w, i) => (
              <div
                key={w.id}
                draggable={editMode}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== i) move(dragIndex, i);
                  setDragIndex(null);
                }}
                className={cn(
                  "col-span-12",
                  w.w === 4 && "md:col-span-4",
                  w.w === 5 && "md:col-span-5",
                  w.w === 6 && "md:col-span-6",
                  w.w === 7 && "md:col-span-7",
                  w.w === 8 && "md:col-span-8",
                  w.w === 12 && "md:col-span-12",
                )}
              >
                <Card className={cn("flex h-full flex-col", editMode && "ring-1 ring-line/60")}>
                  <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {editMode && <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-muted/60" />}
                      <p className="truncate text-sm font-medium text-foreground">{w.title}</p>
                      <WidgetTag type={w.type} />
                    </div>
                    {editMode && (
                      <div className="flex shrink-0 items-center gap-1">
                        <select
                          aria-label="Widget width"
                          value={String(w.w ?? 6)}
                          onChange={(e) => update(w.id, { w: Number(e.target.value) })}
                          className="h-7 rounded border border-line bg-surface px-1 text-caption focus:outline-none focus:ring-2 focus:ring-focus/60"
                        >
                          <option value="4">¼</option>
                          <option value="6">½</option>
                          <option value="8">⅔</option>
                          <option value="12">full</option>
                        </select>
                        <button
                          aria-label="Remove widget"
                          onClick={() => remove(w.id)}
                          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                        >
                          <X aria-hidden className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div
                    className="thin-scroll flex-1 overflow-auto p-3"
                    onFocus={() => reportFocus(w.id)}
                    onMouseEnter={() => reportFocus(w.id)}
                  >
                    {/* Live cursor badge (ROADMAP 7.2): peers focused on THIS widget. */}
                    {(peersByWidget.get(w.id) ?? []).slice(0, 3).map((p) => (
                      <span
                        key={p.id}
                        title={`${p.name} is here`}
                        aria-label={`${p.name} is viewing this widget`}
                        className="float-right -mt-1 inline-flex size-5 items-center justify-center rounded-full text-[10px] font-bold text-black ring-2 ring-background"
                        style={{ backgroundColor: p.color }}
                      >
                        {(p.name || "?").slice(0, 1).toUpperCase()}
                      </span>
                    ))}
                    <CrossFilterableBody
                      widget={w}
                      original={activePage.widgets.find((o) => o.id === w.id) ?? w}
                      numStyle={props.numStyle ?? "comma"}
                      insights={props.insights}
                      onText={(t) => update(w.id, { content: t })}
                      editable={editMode}
                      onPick={(value, opts) =>
                        onTileClick(activePage.widgets.find((o) => o.id === w.id) ?? w, value, opts)
                      }
                      slicerSelected={slicerState[w.id] ?? []}
                      onSlicerToggle={(value) =>
                        onSlicerToggle(activePage.widgets.find((o) => o.id === w.id) ?? w, value)
                      }
                      activePage={activePage}
                      onTileClick={onTileClick}
                      setDrillUrl={setDrillUrl}
                      setDrill={setDrill}
                    />
                  </div>
                </Card>
              </div>
            ))}
          </div>
        </>
      )}

      <AddWidgetDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        analyses={props.analyses}
        insights={props.insights}
        widgetsRef={widgetsLive}
        onAdd={(w) => {
          mutateWidgets((ws) => [...ws, w]);
          setAddOpen(false);
        }}
      />

      {/* Drill-through detail dialog */}
      <Dialog
        open={drill !== null}
        onClose={() => {
          setDrill(null);
          setDrillUrl(null);
        }}
        title={drill?.title ?? ""}
        description={
          drill
            ? `Detail for ${drill.column} = ${drill.value} — ${drill.totalRows} row(s) from the widget's stored snapshot.`
            : ""
        }
        size="lg"
        footer={
          <div className="flex items-center gap-2">
            {drill && drillUrl && (
              <Link
                href={drillUrl}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
              >
                Full detail page
                <ArrowUpRight aria-hidden className="size-4" />
              </Link>
            )}
            <Button variant="secondary" onClick={() => setDrill(null)}>
              Close
            </Button>
          </div>
        }
      >
        {drill && drill.rows.length > 0 && (
          <DataTable
            columns={drill.columns}
            rows={drill.rows}
            pageSize={12}
            numStyle={props.numStyle ?? "comma"}
            caption={drill.sampled ? `Sampled — showing ${drill.rows.length} of ${drill.totalRows} rows` : undefined}
          />
        )}
        {drill && drill.rows.length === 0 && (
          <p className="text-sm text-muted">No rows matched this value in the widget&rsquo;s snapshot.</p>
        )}
      </Dialog>
    </div>
  );
}

/**
 * Wrapper around WidgetBody that adds Power BI–style interaction: clicking a
 * category on a chart/table/PBI visual toggles the dashboard cross-filter,
 * and the ⌕ button opens the drill-through detail for a picked value.
 */
function CrossFilterableBody({
  widget,
  original,
  numStyle,
  insights,
  onText,
  editable,
  onPick,
  slicerSelected,
  onSlicerToggle,
  activePage,
  onTileClick,
}: {
  widget: DashboardWidget;
  original: DashboardWidget;
  numStyle: "comma" | "dot" | "plain";
  insights: InsightCard[];
  onText: (t: string) => void;
  editable: boolean;
  onPick: (value: string, opts?: { drill?: boolean }) => void;
  slicerSelected: string[];
  onSlicerToggle: (value: string) => void;
  activePage: ReportPage;
  onTileClick: (widget: DashboardWidget, value: string, opts?: { drill?: boolean }) => void;
  setDrillUrl: (url: string | null) => void;
  setDrill: (drill: DrillThroughResult | null) => void;
}) {
  if (widget.type === "slicer") {
    return <SlicerBody widget={widget} selected={slicerSelected} onToggle={onSlicerToggle} />;
  }
  const clickable = widget.type === "chart" || widget.type === "table" || widget.type === "pbi-visual";
  if (!clickable) {
    return (
      <WidgetBody
        w={widget}
        numStyle={numStyle}
        insights={insights}
        onText={onText}
        editable={editable}
        activePage={activePage}
        onTileClick={onTileClick}
      />
    );
  }
  const values = widgetCategories(original).values.filter((v) => v !== "");
  const unique = [...new Set(values)].slice(0, 24);
  return (
    <div className="flex h-full flex-col">
      <WidgetBody
        w={widget}
        numStyle={numStyle}
        insights={insights}
        onText={onText}
        editable={editable}
        activePage={activePage}
        onTileClick={onTileClick}
      />
      {unique.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
          <span className="text-caption text-muted">Click to filter:</span>
          {unique.map((v) => (
            <button
              key={v}
              onClick={(e) => onPick(v, { drill: e.shiftKey })}
              title={`Click: cross-filter the dashboard to “${v}” · Shift-click: drill through to detail`}
              className="max-w-32 truncate rounded-full border border-line px-2 py-0.5 text-caption text-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-foreground"
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetTag({ type }: { type: DashboardWidget["type"] }) {
  const map: Record<string, "default" | "accent" | "warning" | "info" | "success"> = {
    kpi: "accent",
    chart: "success",
    table: "default",
    text: "default",
    insight: "warning",
    filter: "info",
    recommendation: "warning",
    pivot: "default",
    "pbi-visual": "info",
    slicer: "info",
  };
  return (
    <Badge variant={map[type] ?? "default"} className="capitalize">
      {type}
    </Badge>
  );
}

/**
 * The slicer widget body: a Power BI–style filter control over the real
 * distinct values of its column. Single-select shows radio-style rows;
 * multi-select shows checkbox rows; the whole list is scrollable and
 * screen-reader labelled. Nothing is selected ⇒ it filters nothing.
 */
function SlicerBody({
  widget,
  selected,
  onToggle,
}: {
  widget: DashboardWidget;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const spec = widget.slicer;
  if (!spec) {
    return <p className="text-sm text-muted">This slicer has no configuration — delete and re-add it.</p>;
  }
  const multi = spec.multiSelect ?? true;
  const clear = () => selected.forEach((v) => onToggle(v));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-caption font-medium text-muted">Filter by {spec.column}</p>
        {selected.length > 0 && (
          <button onClick={clear} className="text-caption text-accent hover:underline">
            Clear ({selected.length})
          </button>
        )}
      </div>
      {spec.style === "dropdown" ? (
        <select
          aria-label={`Slicer: ${spec.column}`}
          value={selected[0] ?? ""}
          onChange={(e) => {
            if (e.target.value === "") {
              // Deselect everything.
              [...selected].forEach((v) => onToggle(v));
            } else if (multi) {
              onToggle(e.target.value);
            } else if (selected[0] !== e.target.value) {
              onToggle(e.target.value);
            }
          }}
          className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
        >
          <option value="">(All)</option>
          {spec.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <div
          role="group"
          aria-label={`Slicer: ${spec.column}`}
          className="thin-scroll max-h-44 space-y-0.5 overflow-y-auto pr-1"
        >
          {spec.values.map((v) => {
            const on = selected.includes(v);
            return (
              <button
                key={v}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => onToggle(v)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition-colors ${
                  on ? "bg-accent/10 font-medium text-foreground" : "text-muted hover:bg-surface-2"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                    on ? "border-accent bg-accent text-white" : "border-line bg-surface"
                  }`}
                >
                  {on ? "✓" : ""}
                </span>
                <span className="truncate">{v}</span>
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-caption text-muted">
        {multi ? "Multi-select on" : "Single-select"} · {spec.values.length} value(s) from the dashboard snapshot
      </p>
    </div>
  );
}

function WidgetBody({
  w,
  numStyle,
  insights: _insights,
  onText,
  editable,
  activePage,
  onTileClick,
}: {
  w: DashboardWidget;
  numStyle: "comma" | "dot" | "plain";
  insights: InsightCard[];
  onText: (t: string) => void;
  editable: boolean;
  activePage: ReportPage;
  onTileClick: (widget: DashboardWidget, value: string, opts?: { drill?: boolean }) => void;
}) {
  if (w.type === "text") {
    return editable ? (
      <textarea
        aria-label="Text content"
        value={w.content ?? ""}
        onChange={(e) => onText(e.target.value)}
        className="min-h-20 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
      />
    ) : (
      <p className="whitespace-pre-wrap text-sm text-muted">{w.content}</p>
    );
  }
  if (w.type === "chart" && w.chart) return <ChartRenderer spec={w.chart} numStyle={numStyle} bare height={260} />;
  if (w.type === "table" && w.table)
    return <DataTable columns={w.table.columns} rows={w.table.rows} pageSize={10} numStyle={numStyle} />;
  if (w.type === "insight" && w.insight) return <InsightCardView insight={w.insight} />;
  if (w.type === "filter") {
    return (
      <p className="rounded border border-line bg-surface-2/60 px-3 py-2 text-caption text-muted">
        Filter on this dashboard:{" "}
        {w.content || "Configured when saved. Widget snapshots respect the analysis filters they were built from."}
      </p>
    );
  }
  if (w.type === "recommendation") {
    return (
      <div className="rounded border-l-2 border-accent bg-accent/5 px-3 py-2.5">
        <p className="text-sm font-medium text-foreground">{w.content || "Recommendation"}</p>
      </div>
    );
  }
  if (w.type === "pivot" && w.pivot) {
    return (
      <PivotCell
        datasetId={w.datasetId || (w.pivot.datasetId ?? "")}
        rows={w.pivot.rows}
        columns={w.pivot.columns}
        values={w.pivot.values}
        onCellClick={w.pivot.onCellClick}
      />
    );
  }
  if (w.type === "pbi-visual" && w.pbiVisual) {
    if (w.pbiVisual.kind === ("map" as string)) {
      return (
        <ChoroplethWidget
          spec={w.pbiVisual}
          widgetId={w.id}
          widgets={activePage.widgets}
          scope={w.mapScope ?? "countries"}
          title={w.title}
          onTileClick={onTileClick}
          onDrillClick={() => {}}
        />
      );
    }
    return (
      <PbiVisual
        spec={{
          ...w.pbiVisual,
          format: w.format
            ? { dataLabels: w.format.dataLabels, referenceLine: w.format.referenceLine, palette: w.format.palette }
            : w.pbiVisual.format,
        }}
        height={260}
      />
    );
  }
  return <p className="text-sm text-muted">This widget needs content — edit the dashboard to attach data.</p>;
}

function AddWidgetDialog({
  open,
  onClose,
  analyses,
  insights,
  onAdd,
  widgetsRef,
}: {
  open: boolean;
  onClose: () => void;
  analyses: WidgetSourceAnalysis[];
  insights: InsightCard[];
  onAdd: (w: DashboardWidget) => void;
  widgetsRef: MutableRefObject<DashboardWidget[]>;
}) {
  const [category, setCategory] = useState<AddKind>("chart");
  const [error, _setError] = useState<string | null>(null);
  const chartAnalyses = analyses.filter((a) => a.result?.charts[0]);
  const tableAnalyses = analyses.filter((a) => a.result?.tables?.[0]);
  const kpiAnalyses = analyses.filter((a) => a.result?.charts.some((c) => c.kind === "kpi") || a.result?.stats);
  const pivotAnalyses = analyses.filter((a) => (a.result?.charts.length ?? 0) > 0);
  const [pbiKind, setPbiKind] = useState<string>("pareto");
  const [pbiError, setPbiError] = useState<string | null>(null);

  // ---- Pivot field builder (P8/E17): drag-drop wells over pivot-grid.ts -----
  const [pivotAnalysisId, setPivotAnalysisId] = useState<string>("");
  const [pivotFields, setPivotFields] = useState<PivotField[]>([]);
  const [pivotState, setPivotState] = useState<PivotFieldState>(emptyFieldState);
  const [pivotFieldsLoading, setPivotFieldsLoading] = useState(false);
  const activePivotAnalysisId = pivotAnalysisId || pivotAnalyses[0]?.id || "";
  const activePivotAnalysis = pivotAnalyses.find((a) => a.id === activePivotAnalysisId);

  // Load the source dataset's real columns when the pivot tab opens.
  useEffect(() => {
    if (category !== "pivot" || !activePivotAnalysisId) return;
    let cancelled = false;
    setPivotFieldsLoading(true);
    (async () => {
      try {
        const data = await api<{ schema: { columns: { name: string; type: string }[] } }>(
          `/api/datasets/${activePivotAnalysisId}/schema`,
        );
        if (cancelled) return;
        const mapType = (t: string): PivotField["type"] =>
          t === "number" ? "number" : t === "date" ? "date" : t === "boolean" ? "boolean" : "string";
        setPivotFields((data.schema.columns ?? []).map((c) => ({ name: c.name, type: mapType(c.type) })));
      } catch {
        if (!cancelled) setPivotFields([]);
      } finally {
        if (!cancelled) setPivotFieldsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [category, activePivotAnalysisId]);

  const addPbiVisual = (a: WidgetSourceAnalysis) => {
    const result = a.result;
    if (!result) return;
    const chart = result.charts.find((c) => c.kind !== "kpi") ?? result.charts[0];
    if (!chart) return;
    try {
      const spec =
        pbiKind === "map"
          ? buildMapSpec({ title: a.title, chart })
          : buildPbiSpec(pbiKind as PbiVisualKind, { title: a.title, chart });
      setPbiError(null);
      onAdd({
        id: uid("w"),
        type: "pbi-visual",
        title: `${a.title} · ${pbiKind}`,
        analysisId: a.id,
        pbiVisual: spec,
        ...(pbiKind === "map" ? { mapScope: detectMapScope(chart.categories ?? []) } : {}),
        w: 6,
        h: 4,
        sourceDatasetName: result.dataset.name,
      });
    } catch (err) {
      setPbiError(err instanceof Error ? err.message : "Could not derive that visual from this analysis.");
    }
  };

  const addChart = (a: WidgetSourceAnalysis, source: "chart" | "table") => {
    const result = a.result;
    if (!result) return;
    if (source === "chart") {
      const chart = result.charts.find((c) => c.kind !== "kpi") ?? result.charts[0];
      if (!chart) return;
      onAdd({
        id: uid("w"),
        type: "chart",
        title: `${a.title}`,
        analysisId: a.id,
        chart,
        w: 6,
        h: 4,
        sourceDatasetName: result.dataset.name,
      });
    } else {
      const table = result.tables?.[0];
      if (!table) return;
      onAdd({
        id: uid("w"),
        type: "table",
        title: `${a.title} · ${table.title}`,
        analysisId: a.id,
        table,
        w: 6,
        h: 4,
        sourceDatasetName: result.dataset.name,
      });
    }
  };

  const addKpi = (a: WidgetSourceAnalysis) => {
    const result = a.result;
    if (!result) return;
    const kpi = result.charts.find((c) => c.kind === "kpi");
    onAdd({
      id: uid("w"),
      type: "kpi",
      title: a.title,
      analysisId: a.id,
      chart: kpi,
      kpiKind: "sum", // sum | mean | min | max | count
      w: 12,
      h: 2,
      sourceDatasetName: result.dataset.name,
    });
  };

  const addInsight = (i: InsightCard) => {
    onAdd({ id: uid("w"), type: "insight", title: i.title, insight: i, w: 6, h: 4 });
  };

  // Slicers: distinct filterable columns from the analyses already on the
  // canvas (chart x-labels + table first-column labels).
  const slicerColumns: string[] = (() => {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const a of chartAnalyses) {
      const c = a.result?.charts.find((x) => x.kind !== "kpi") ?? a.result?.charts[0];
      const col = c?.xLabel ?? a.title;
      if (col && !seen.has(col)) {
        seen.add(col);
        cols.push(col);
      }
    }
    for (const a of tableAnalyses) {
      const t = a.result?.tables?.[0];
      const col = t?.columns[0] ? String(t.columns[0].label ?? t.columns[0].key) : null;
      if (col && !seen.has(col)) {
        seen.add(col);
        cols.push(col);
      }
    }
    return cols;
  })();

  const categories: { key: AddKind; label: string; count: number }[] = [
    { key: "chart", label: "Charts from analyses", count: chartAnalyses.length },
    { key: "table", label: "Tables from analyses", count: tableAnalyses.length },
    { key: "kpi", label: "KPI & stat cards", count: kpiAnalyses.length },
    { key: "pivot", label: "Pivot table", count: pivotAnalyses.length },
    { key: "pbi", label: "Power BI visuals", count: chartAnalyses.length },
    { key: "insight", label: "Insight cards", count: insights.length },
    { key: "slicer", label: "Slicers", count: slicerColumns.length },
    { key: "map", label: "Filled maps", count: chartAnalyses.length },
    { key: "text", label: "Text note", count: 1 },
  ];

  const [slicerColumn, setSlicerColumn] = useState<string>(slicerColumns[0] ?? "");
  const [slicerMulti, setSlicerMulti] = useState(true);
  const [slicerStyle, setSlicerStyle] = useState<"list" | "dropdown">("list");

  const addSlicerWidget = async (column: string) => {
    try {
      // REAL SOURCE FIRST: fetch the column's distinct values from the dataset
      // (RLS-filtered server read — the same rows every other view sees).
      // Fall back to the canvas-widget snapshots when the source dataset is
      // unknown (widgets added from insights/text carry no datasetId).
      let spec: ReturnType<typeof buildSlicer>;
      const sourceDatasetId =
        widgetsRef.current.find((w) => w.datasetId)?.datasetId ??
        widgetsRef.current.find((w) => w.pivot?.datasetId)?.pivot?.datasetId;
      let values: string[] | null = null;
      if (sourceDatasetId) {
        try {
          const res = await api<{ data: { values: string[] } }>(
            `/api/datasets/${sourceDatasetId}/values?column=${encodeURIComponent(column)}&limit=200`,
          );
          values = res.data.values.length ? res.data.values : null;
        } catch {
          values = null; // fall through to the snapshot path
        }
      }
      if (values) {
        spec = { column, values, style: slicerStyle, multiSelect: slicerMulti };
      } else {
        // Snapshot path (throws when NO widget carries the column).
        spec = buildSlicer(uid("slicer"), column, widgetsRef.current, { multiSelect: slicerMulti, style: slicerStyle });
      }
      setPbiError(null);
      onAdd({
        id: uid("w"),
        type: "slicer",
        title: `Slicer · ${column}`,
        slicer: spec,
        w: 3,
        h: 4,
      });
    } catch (err) {
      setPbiError(err instanceof Error ? err.message : "Could not build that slicer.");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a widget"
      description="Widgets are snapshots computed from your dataset — refresh the dashboard to update them."
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error && <ErrorMessage title="Could not add widget" message={error} className="mb-3" />}
      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label="Widget sources" className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={category === c.key}
              onClick={() => setCategory(c.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-caption transition-colors",
                category === c.key
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-line text-muted hover:bg-surface-2",
              )}
            >
              {c.label} ({c.count})
            </button>
          ))}
        </div>

        <div role="tabpanel" className="thin-scroll max-h-80 overflow-y-auto pr-1">
          {category === "chart" && chartAnalyses.length === 0 && (
            <Hint text="Run an analysis that produces a chart first." />
          )}
          {category === "chart" &&
            chartAnalyses.map((a) => (
              <SourceRow
                key={a.id}
                title={a.title}
                subtitle={`${a.kind} · ${a.result?.charts[0]?.title ?? ""}`}
                onPick={() => addChart(a, "chart")}
              />
            ))}
          {category === "table" && tableAnalyses.length === 0 && (
            <Hint text="Run an analysis with a results table (trend, correlation, variance…)." />
          )}
          {category === "table" &&
            tableAnalyses.map((a) => (
              <SourceRow
                key={a.id}
                title={`${a.title} · table`}
                subtitle={a.result?.tables?.[0]?.title ?? ""}
                onPick={() => addChart(a, "table")}
              />
            ))}
          {category === "kpi" && kpiAnalyses.length === 0 && (
            <Hint text="Run a KPI analysis to surface headline numbers." />
          )}
          {category === "kpi" &&
            kpiAnalyses.map((a) => (
              <SourceRow key={a.id} title={a.title} subtitle="KPI / stat summary" onPick={() => addKpi(a)} />
            ))}
          {category === "pivot" && pivotAnalyses.length === 0 && (
            <Hint text="Run an analysis first — the pivot builder reads the dataset behind it." />
          )}
          {category === "pivot" && pivotAnalyses.length > 0 && (
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-caption font-medium text-muted">Source dataset</label>
                <select
                  aria-label="Pivot source dataset"
                  value={activePivotAnalysisId}
                  onChange={(e) => {
                    setPivotAnalysisId(e.target.value);
                    setPivotState(emptyFieldState());
                  }}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                >
                  {pivotAnalyses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.result?.dataset.name ?? a.title} — {a.title}
                    </option>
                  ))}
                </select>
              </div>
              {pivotFieldsLoading ? (
                <p className="text-caption text-muted">Loading columns…</p>
              ) : pivotFields.length === 0 ? (
                <p className="text-caption text-muted">Could not read this dataset&apos;s columns.</p>
              ) : (
                <PivotFieldBuilder
                  fields={pivotFields}
                  value={pivotState}
                  onChange={setPivotState}
                  datasetName={activePivotAnalysis?.result?.dataset.name}
                  applyLabel="Add pivot to dashboard"
                  onApply={(state) => {
                    const ds = activePivotAnalysis?.result?.dataset;
                    onAdd({
                      id: uid("w"),
                      type: "pivot",
                      title: `${ds?.name ?? "Dataset"} · pivot`,
                      analysisId: activePivotAnalysis?.id,
                      datasetId: ds?.id,
                      pivot: {
                        rows: state.rows,
                        columns: state.columns,
                        values: state.values,
                        ...(ds?.id ? { datasetId: ds.id } : {}),
                      },
                      sourceDatasetName: ds?.name,
                      w: 6,
                      h: 4,
                    });
                  }}
                />
              )}
            </div>
          )}
          {category === "pbi" && (
            <div className="mb-3">
              <label className="mb-1.5 block text-caption font-medium text-muted">Visual type</label>
              <div role="listbox" aria-label="Power BI visual type" className="flex flex-wrap gap-1.5">
                {VISUAL_PICKER_OPTIONS.map((o) => (
                  <button
                    key={o.kind}
                    role="option"
                    aria-selected={pbiKind === o.kind}
                    title={o.hint}
                    onClick={() => setPbiKind(o.kind)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-caption transition-colors",
                      pbiKind === o.kind
                        ? "border-accent bg-accent/10 text-foreground"
                        : "border-line text-muted hover:bg-surface-2",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {pbiError && <p className="mt-2 text-caption text-danger">{pbiError}</p>}
            </div>
          )}
          {category === "pbi" &&
            chartAnalyses.map((a) => (
              <SourceRow
                key={a.id}
                title={`${a.title} → ${VISUAL_PICKER_OPTIONS.find((o) => o.kind === pbiKind)?.label ?? pbiKind}`}
                subtitle={a.result?.charts[0]?.title ?? ""}
                onPick={() => addPbiVisual(a)}
              />
            ))}
          {category === "insight" && insights.length === 0 && <Hint text="Generate insights on a dataset first." />}
          {category === "insight" &&
            insights.map((i) => (
              <SourceRow
                key={i.id}
                title={i.title}
                subtitle={`${i.severity} · ${i.confidence}`}
                onPick={() => addInsight(i)}
              />
            ))}
          {category === "slicer" &&
            (slicerColumns.length === 0 ? (
              <Hint text="Add a chart or table widget first — a slicer filters the columns those visuals carry." />
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-caption font-medium text-muted">Column to filter</label>
                  <select
                    aria-label="Slicer column"
                    value={slicerColumn || slicerColumns[0]}
                    onChange={(e) => setSlicerColumn(e.target.value)}
                    className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                  >
                    {slicerColumns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={slicerMulti}
                      onChange={(e) => setSlicerMulti(e.target.checked)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    Multi-select
                  </label>
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="radio"
                      name="slicer-style"
                      checked={slicerStyle === "list"}
                      onChange={() => setSlicerStyle("list")}
                      className="size-4 accent-[var(--accent)]"
                    />
                    List
                  </label>
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="radio"
                      name="slicer-style"
                      checked={slicerStyle === "dropdown"}
                      onChange={() => setSlicerStyle("dropdown")}
                      className="size-4 accent-[var(--accent)]"
                    />
                    Dropdown
                  </label>
                </div>
                <Button
                  size="sm"
                  onClick={() => addSlicerWidget(slicerColumn || slicerColumns[0]!)}
                  disabled={!slicerColumns.length}
                >
                  Add slicer
                </Button>
                <p className="text-caption text-muted">
                  The slicer offers the real distinct values of the column from the widgets already on this canvas.
                </p>
              </div>
            ))}
          {category === "text" && (
            <button
              onClick={() => onAdd({ id: uid("w"), type: "text", title: "Note", content: "", w: 12, h: 2 })}
              className="card w-full p-4 text-left hover:shadow-pop"
            >
              <p className="font-medium text-foreground">Add an empty text note</p>
              <p className="text-sm text-muted">Free-form commentary, context or callouts for the audience.</p>
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Lazy Leaflet choropleth — loaded only when a map widget actually renders
 * (Leaflet touches `window` at import time, so it must never be on the
 * server bundle).
 */
const ChoroplethMap = dynamic(() => import("@/components/charts/choropleth-map").then((m) => m.ChoroplethMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-line bg-surface-2/60 text-sm text-muted">
      Loading map…
    </div>
  ),
});

/**
 * Lazy ECharts visual. `pbi-visual.tsx` does `import * as echarts`, which
 * pulls the ~1 MB ECharts runtime in; importing it eagerly put that on the
 * dashboard EDITOR's critical path even for dashboards with no pbi-visual
 * widget. Fetched on first render instead, same as the published viewer.
 */
const PbiVisual = dynamic(() => import("@/components/charts/pbi-visual").then((m) => m.PbiVisual), {
  ssr: false,
  loading: () => <div aria-hidden className="w-full animate-pulse rounded-md bg-surface-2" style={{ height: 260 }} />,
});

function ChoroplethWidget({
  spec,
  widgetId,
  widgets,
  scope,
  title,
  onTileClick,
  onDrillClick,
}: {
  spec: { categories: string[]; values: number[] };
  widgetId?: string;
  widgets: DashboardWidget[];
  scope: "us-states" | "countries";
  title: string;
  onTileClick: (widget: DashboardWidget, value: string) => void;
  onDrillClick: (widget: DashboardWidget, region: string) => void;
}) {
  const data = spec.categories.map((region, i) => ({ region, value: spec.values[i] ?? 0 }));
  const widget = widgetId
    ? widgets.find((w) => w.id === widgetId)
    : widgets.find((w) => w.title === title);
  return (
    <ChoroplethMap
      title={title}
      metricLabel="Value"
      data={data}
      scope={scope}
      height={260}
      onRegionClick={(region) => {
        // Select this region as a cross-filter
        if (widget?.type === "chart") {
          const { column } = widgetCategories(widget);
          if (column) {
            onTileClick(widget, region);
          }
        }
      }}
      onDrillClick={(region) => {
        // Shift-click drill-through to detail page
        if (widget?.type === "chart" && widget.datasetId) {
          onDrillClick(widget, region);
        }
      }}
    />
  );
}

function SourceRow({ title, subtitle, onPick }: { title: string; subtitle: string; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className="mb-2 w-full rounded-md border border-line px-3 py-2 text-left transition-colors hover:border-accent/50 hover:bg-surface-2"
    >
      <span className="block truncate text-sm font-medium text-foreground">{title}</span>
      <span className="block truncate text-caption text-muted">{subtitle}</span>
    </button>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-line bg-surface-2/60 px-3 py-6 text-center text-sm text-muted">{text}</p>
  );
}
