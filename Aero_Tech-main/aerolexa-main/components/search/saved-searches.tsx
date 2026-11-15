"use client";

import { BookmarkPlus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { savedSearchHref, validateSavedSearch } from "@/lib/search/facets";
import { cn } from "@/lib/utils";

/**
 * Saved searches (client island on /search).
 *
 * Lists the caller's saved (query, type facet, sort) triples, saves the
 * current search, and deletes one. The saved triple re-runs through the
 * same search page/route — a saved search is a bookmark, never a snapshot.
 */

interface SavedRow {
  id: string;
  name: string;
  query: string;
  filter: string;
  href?: string;
}

export function SavedSearchesClient({
  currentQuery,
  currentType,
  currentSort,
}: {
  currentQuery?: string;
  currentType: string | null;
  currentSort: "relevance" | "recent";
}) {
  const [saved, setSaved] = useState<SavedRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasCurrent = (currentQuery ?? "").trim().length >= 2;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/search/saved");
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { saved?: SavedRow[] } };
        if (!cancelled) setSaved(body.data?.saved ?? []);
      } catch {
        /* list load is best-effort */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!hasCurrent || busy) return;
    setBusy(true);
    setError(null);
    try {
      const validation = validateSavedSearch({ query: currentQuery ?? "", type: currentType, sort: currentSort });
      if (!validation.ok || !validation.value) {
        setError(validation.reason ?? "Could not save this search.");
        return;
      }
      const res = await fetch("/api/search/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: validation.value.query,
          type: validation.value.type,
          sort: validation.value.sort,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "Could not save this search.");
      }
      const body = (await res.json()) as { data?: SavedRow };
      if (body.data) {
        setSaved((prev) => [body.data as SavedRow, ...prev.filter((s) => s.name !== body.data!.name)]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this search.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await fetch(`/api/search/saved?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    } catch {
      /* remove is best-effort; refresh below reconciles */
    }
    setSaved((prev) => prev.filter((s) => s.name !== name));
  };

  if (!loaded && saved.length === 0) {
    return <div className="mt-4 h-0" aria-hidden />;
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption font-semibold text-foreground">Saved searches</p>
        {hasCurrent && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => void save()}
            disabled={busy}
            icon={<BookmarkPlus aria-hidden className="size-3.5" />}
          >
            {busy ? "Saving…" : "Save this search"}
          </Button>
        )}
      </div>
      {error && <p className="mt-1.5 text-caption text-danger">{error}</p>}
      {saved.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {saved.map((s) => {
            const parsed = validateSavedSearch({ query: s.query, type: null, sort: "relevance" });
            const href = parsed.ok
              ? savedSearchHref({ query: s.query, type: null, sort: "relevance" })
              : (s.href ?? `/search?q=${encodeURIComponent(s.query)}`);
            return (
              <li
                key={s.id}
                className={cn(
                  "group inline-flex items-center overflow-hidden rounded-full border border-line bg-background",
                )}
              >
                <Link
                  href={href}
                  className="max-w-[240px] truncate px-2.5 py-1 text-caption text-foreground hover:text-accent"
                >
                  {s.name}
                </Link>
                <button
                  type="button"
                  aria-label={`Delete saved search ${s.name}`}
                  onClick={() => void remove(s.name)}
                  className="border-l border-line px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-danger"
                >
                  <Trash2 aria-hidden className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {loaded && saved.length === 0 && !hasCurrent && (
        <p className="mt-1.5 text-caption text-muted">Run a search, then save it to re-run with one click.</p>
      )}
    </div>
  );
}

export default SavedSearchesClient;
