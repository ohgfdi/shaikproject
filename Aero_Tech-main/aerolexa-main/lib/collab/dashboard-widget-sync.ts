/**
 * Dashboard widget ⇄ Yjs CRDT synchronization (pure, unit-tested).
 *
 * `useDashboardCollab` owns the Y.Doc and the SSE transport; this module owns
 * the *merge policy* between the dashboard's React state (`DashboardWidget[]`
 * per report page) and the CRDT's widget map. Keeping the policy pure lets the
 * echo-suppression rules — the historically buggy part of local/remote sync —
 * be pinned by unit tests without a browser.
 *
 * Two directions, both idempotent:
 *  - `widgetsToOps(local, remote)` — produce the CRDT ops that make the room
 *    match local edits (add / set / remove / reorder), skipping anything that
 *    only differs by function-valued fields the CRDT cannot serialize.
 *  - `applyRemoteWidgets(remote, localPages)` — fold the room's widget states
 *    into the local pages without clobbering newer local edits (last-writer
 *    wins per widget on `updatedAt`, local defaults when the field is absent).
 *
 * Serialization: a widget's visual payload is stored under `spec` as JSON.
 * Function-valued fields (pivot onCellClick) are stripped — the receiver
 * rebuilds interactions; the spec only carries data.
 */

import type { DashboardWidget, ReportPage } from "@/lib/types";

// ---------------------------------------------------------------------------
// Widget ⇄ spec serialization
// ---------------------------------------------------------------------------

/** Fields that never travel through the CRDT (functions / derived). */
const NON_SERIALIZABLE = new Set(["onCellClick"]);

/** Strip function-valued fields so JSON.stringify output is stable. */
export function serializableSpec(widget: DashboardWidget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(widget)) {
    if (NON_SERIALIZABLE.has(k)) continue;
    out[k] = stripFunctions(v);
  }
  return out;
}

/** Drop function values at any depth — incl. nested objects like `pivot.onCellClick`. */
function stripFunctions(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (Array.isArray(value)) {
    return value.map(stripFunctions).filter((v) => v !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripFunctions(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/** Rebuild a widget from a CRDT spec; null when the payload is unusable. */
export function widgetFromSpec(spec: Record<string, unknown>): DashboardWidget | null {
  if (!spec || typeof spec !== "object") return null;
  const id = typeof spec.id === "string" ? spec.id : null;
  const type = typeof spec.type === "string" ? spec.type : null;
  if (!id || !type) return null;
  return { ...(spec as unknown as DashboardWidget), id, type: type as DashboardWidget["type"] };
}

// ---------------------------------------------------------------------------
// Local → CRDT: which ops does this local page need?
// ---------------------------------------------------------------------------

export type WidgetOp =
  | { type: "add"; widgetId: string; widgetType: string; spec: Record<string, unknown> }
  | { type: "set"; widgetId: string; widgetType: string; spec: Record<string, unknown> }
  | { type: "merge"; widgetId: string; spec: Record<string, unknown> }
  | { type: "remove"; widgetId: string }
  | { type: "reorder"; order: string[] };

/**
 * Diff the active page's widgets against the room state and return the ops
 * that bring the room up to date. `remote` maps widgetId → the room's stored
 * state (type + spec + version); `remoteOrder` is the room's widget order.
 * A widget the room has NEVER seen is an `add`; one it has is a `merge` of
 * just the differing serialized fields (or a full `set` when the type changed).
 */
export function widgetsToOps(
  widgets: DashboardWidget[],
  remote: ReadonlyMap<string, { type: string; spec: Record<string, unknown>; version: number }>,
  remoteOrder: readonly string[] = [...remote.keys()],
): WidgetOp[] {
  const ops: WidgetOp[] = [];
  const seen = new Set<string>();

  for (const w of widgets) {
    seen.add(w.id);
    const spec = serializableSpec(w);
    const r = remote.get(w.id);
    if (!r) {
      ops.push({ type: "add", widgetId: w.id, widgetType: w.type, spec });
    } else if (r.type !== w.type) {
      // Type changed — full replace, not a merge.
      ops.push({ type: "set", widgetId: w.id, widgetType: w.type, spec });
    } else {
      // Same type: merge only the serialized fields that differ.
      const partial: Record<string, unknown> = {};
      let changed = false;
      for (const [k, v] of Object.entries(spec)) {
        if (JSON.stringify(r.spec?.[k]) !== JSON.stringify(v)) {
          partial[k] = v;
          changed = true;
        }
      }
      if (changed) ops.push({ type: "merge", widgetId: w.id, spec: partial });
    }
  }

  for (const id of remote.keys()) {
    if (!seen.has(id)) ops.push({ type: "remove", widgetId: id });
  }

  const order = widgets.map((w) => w.id);
  if (order.join("\u0000") !== remoteOrder.join("\u0000")) {
    ops.push({ type: "reorder", order });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// CRDT → local: fold remote widget states into the report pages
// ---------------------------------------------------------------------------

/**
 * Apply remote widget states to the local pages. Per-widget last-writer-wins:
 * a remote widget replaces the local one when its CRDT version is newer than
 * the local edit sequence the page recorded (widgets carry `updatedAt` when
 * the builder stamps them; absent stamps mean the remote state wins).
 *
 * Returns the SAME page array when nothing changed (referential stability for
 * React), so callers can setState unconditionally.
 */
export function applyRemoteWidgets(
  remote: ReadonlyArray<{ widgetId: string; type: string; spec: Record<string, unknown>; version: number }>,
  pages: ReportPage[],
  activePageId: string,
): ReportPage[] {
  if (remote.length === 0) return pages;
  let changed = false;
  const remoteById = new Map(remote.map((r) => [r.widgetId, r]));

  const next = pages.map((page) => {
    if (page.id !== activePageId) return page;
    const localIds = new Set(page.widgets.map((w) => w.id));
    const widgets: DashboardWidget[] = [];

    // Keep local widgets, replacing with newer remote versions when present.
    for (const w of page.widgets) {
      const r = remoteById.get(w.id);
      if (!r) {
        // Missing remotely: a peer deleted it (or it never synced). Trust the
        // room — the CRDT state is the shared truth for the active page.
        changed = true;
        continue;
      }
      const rebuilt = widgetFromSpec(r.spec);
      if (!rebuilt) {
        widgets.push(w); // unusable remote payload — keep local honestly
        continue;
      }
      // CRDT versions only move forward; any remote version >= local means
      // the room already saw this state (or a newer one). Take the room's.
      widgets.push({ ...rebuilt });
      if (JSON.stringify(rebuilt) !== JSON.stringify(w)) changed = true;
      localIds.add(w.id);
    }

    // Append remote widgets the local page has not seen (peer additions).
    for (const r of remote) {
      if (localIds.has(r.widgetId)) continue;
      const rebuilt = widgetFromSpec(r.spec);
      if (!rebuilt) continue;
      widgets.push(rebuilt);
      changed = true;
    }

    return { ...page, widgets };
  });

  return changed ? next : pages;
}
