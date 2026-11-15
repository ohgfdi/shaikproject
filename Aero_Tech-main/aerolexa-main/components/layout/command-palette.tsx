"use client";

/**
 * Global ⌘K command palette (ROADMAP 7.1).
 *
 * One overlay, mounted once in the AppShell:
 *   - ⌘K / Ctrl+K toggles it from anywhere in the app shell;
 *   - empty query lists navigation actions (every nav destination + settings);
 *   - typing ≥2 chars debounces a call to GET /api/search and lists the
 *     workspace's projects, datasets, analyses, insights, notebooks, models,
 *     prompts, dashboards, reports and presentations;
 *   - ↑/↓ move, Enter opens, Esc closes; results are scoped to the caller's
 *     workspace server-side (requireAuth), so nothing leaks across tenants.
 *
 * Fuzzy ranking: simple subsequence scoring over the title, preferring
 * prefix matches — deterministic, dependency-free, fast enough for the
 * ≤60 hits the API returns.
 */

import {
  BarChart3,
  Bell,
  FileSpreadsheet,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  MessageSquareText,
  Notebook,
  PencilRuler,
  Presentation,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { navGroupsFor } from "@/components/layout/nav-config";
import { api, errorMessage } from "@/lib/client/api";
import { rankHits, scoreQuery } from "@/lib/client/command-palette-core";
import { cn } from "@/lib/utils";

interface SearchHit {
  id: string;
  type: string;
  title: string;
  sub?: string;
  href: string;
  date?: string;
}

interface Action {
  label: string;
  href: string;
  icon: typeof Search;
  keywords?: string;
}

/**
 * Destinations that are not primary navigation but are still reachable in one
 * keystroke. The main list comes from the SAME nav config as the sidebar, so a
 * capability can never be discoverable in one surface and missing from the
 * other.
 */
const EXTRA_ACTIONS: Action[] = [
  { label: "Datasets upload", href: "/datasets", icon: FileSpreadsheet, keywords: "upload csv excel data" },
  { label: "Search everything", href: "/search", icon: Search },
  { label: "Notifications", href: "/notifications", icon: Bell },
];

// Scoring lives in lib/client/command-palette-core.ts (unit-gated); the
// component only composes it.

const TYPE_ICON: Record<string, typeof Search> = {
  Project: FolderKanban,
  Dataset: FileSpreadsheet,
  Analysis: FlaskConical,
  Insight: Sparkles,
  Notebook: Notebook,
  Model: BarChart3,
  Prompt: MessageSquareText,
  Dashboard: LayoutDashboard,
  Report: PencilRuler,
  Presentation: Presentation,
};

export function CommandPalette({ moduleFlags = {} }: { moduleFlags?: Partial<Record<string, boolean>> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // ⌘K / Ctrl+K toggles; Esc closes while open. The header search button
  // opens the palette through the same custom event (one source of truth).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpenEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("aerolexa:command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("aerolexa:command-palette", onOpenEvent);
    };
  }, []);

  // Focus the input each time the palette opens; reset prior state.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHits([]);
      setError(null);
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search — only for queries of 2+ chars.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        setHits(data.hits);
        setError(null);
        setActive(0);
      } catch (err) {
        setError(errorMessage(err));
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Static nav actions — derived from the sidebar config. Frozen modules appear
  // only when their flag is on, so both surfaces agree by construction.
  const actions = useMemo(() => {
    const navActions: Action[] = navGroupsFor(moduleFlags).flatMap((group) =>
      group.items.map((item) => ({
        label: item.label,
        href: item.href,
        icon: item.icon,
        keywords: `${group.label} ${item.keywords ?? ""}`.trim(),
      })),
    );
    const visible = [...navActions, ...EXTRA_ACTIONS];
    if (query.trim().length === 0) return visible.map((a) => ({ kind: "action" as const, action: a, hit: null }));
    return visible
      .map((a) => ({
        a,
        s: Math.max(scoreQuery(query, a.label), (a.keywords ? scoreQuery(query, a.keywords) : 0) * 0.8),
      }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .map((x) => ({ kind: "action" as const, action: x.a, hit: null }));
  }, [query, moduleFlags]);

  const hitItems = useMemo(() => {
    if (query.trim().length < 2) return [];
    return rankHits(query, hits).map((h) => ({ kind: "hit" as const, action: null, hit: h }));
  }, [query, hits]);

  const items = useMemo(() => [...actions.slice(0, 6), ...hitItems], [actions, hitItems]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(items.length - 1, 0)));
  }, [items.length]);

  const choose = (href: string) => {
    setOpen(false);
    // Full navigation through the SPA router via a plain assignment keeps
    // this component free of next/navigation while still client-side.
    window.location.assign(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) choose(item.hit ? item.hit.href : item.action!.href);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div aria-hidden className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-pop animate-fade-in">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[active] ? `cp-item-${active}` : undefined}
            placeholder="Search projects, datasets, dashboards… or jump to a page"
            className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-line px-1.5 py-0.5 text-caption text-muted">Esc</kbd>
        </div>
        {error && <p className="px-4 py-2 text-caption text-danger">{error}</p>}
        <ul id="command-palette-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-auto p-2">
          {query.trim().length >= 2 && loading && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {items.length === 0 && !loading && (
            <li className="px-3 py-6 text-center text-sm text-muted">
              {query.trim().length >= 2 ? "Nothing found." : "Type to search, or pick a destination."}
            </li>
          )}
          {items.map((item, i) => {
            const isHit = item.kind === "hit";
            const label = isHit ? item.hit!.title : item.action!.label;
            const sub = isHit ? (item.hit!.sub ?? item.hit!.type) : item.action!.keywords;
            const Icon = isHit ? (TYPE_ICON[item.hit!.type] ?? Search) : item.action!.icon;
            return (
              <li
                key={`${item.kind}-${isHit ? item.hit!.id : item.action!.href}`}
                id={`cp-item-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(isHit ? item.hit!.href : item.action!.href)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                  i === active ? "bg-accent/12 text-foreground" : "text-muted hover:bg-surface-2",
                )}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{label}</span>
                  {sub && <span className="block truncate text-caption text-muted">{sub}</span>}
                </span>
                {isHit && (
                  <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-caption text-muted">
                    {item.hit!.type}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
