/**
 * Unit tests for the dashboard widget ⇄ CRDT sync policy
 * (lib/collab/dashboard-widget-sync.ts) — the merge/echo rules that keep
 * local React state and the Yjs room consistent, pinned without a browser.
 */
import { applyRemoteWidgets, serializableSpec, widgetFromSpec, widgetsToOps } from "@/lib/collab/dashboard-widget-sync";
import type { DashboardWidget, ReportPage } from "@/lib/types";

function widget(id: string, overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id,
    type: "kpi",
    title: `Widget ${id}`,
    w: 4,
    h: 2,
    kpi: { label: "Revenue", value: 42, kind: "sum" },
    ...overrides,
  } as DashboardWidget;
}

function page(widgets: DashboardWidget[]): ReportPage[] {
  return [{ id: "page-1", name: "Page 1", widgets }];
}

describe("serializableSpec / widgetFromSpec", () => {
  it("strips function-valued fields (pivot onCellClick) and keeps data", () => {
    const w = widget("p1", {
      type: "pivot",
      pivot: {
        rows: ["region"],
        columns: [],
        values: [{ column: "revenue", aggregation: "sum" }],
        onCellClick: () => undefined,
      },
    });
    const spec = serializableSpec(w);
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    expect(Object.keys(spec)).not.toContain("onCellClick");
  });

  it("round-trips a widget through spec → fromSpec", () => {
    const w = widget("w9", { title: "Custom", w: 6, h: 3 });
    const back = widgetFromSpec(serializableSpec(w));
    expect(back).toEqual(w);
  });

  it("rejects specs without id or type", () => {
    expect(widgetFromSpec({ type: "kpi" })).toBeNull();
    expect(widgetFromSpec({ id: "x" })).toBeNull();
    expect(widgetFromSpec(null as never)).toBeNull();
  });
});

describe("widgetsToOps — local edits → room ops", () => {
  it("emits add for widgets the room has never seen", () => {
    const w = widget("a1");
    const ops = widgetsToOps([w], new Map());
    expect(ops).toContainEqual({ type: "add", widgetId: "a1", widgetType: "kpi", spec: serializableSpec(w) });
  });

  it("emits merge with ONLY the differing fields for same-type edits", () => {
    const before = widget("m1", { title: "Old" });
    const remote = new Map([["m1", { type: "kpi", spec: serializableSpec(before), version: 1 }]]);
    const after = { ...before, title: "New" };
    const ops = widgetsToOps([after], remote);
    const merge = ops.find((o) => o.type === "merge");
    expect(merge).toEqual({ type: "merge", widgetId: "m1", spec: { title: "New" } });
  });

  it("emits no merge when nothing differs (idempotent echo suppression)", () => {
    const w = widget("m2");
    const remote = new Map([["m2", { type: "kpi", spec: serializableSpec(w), version: 3 }]]);
    const ops = widgetsToOps([w], remote);
    expect(ops.find((o) => o.type === "merge" || o.type === "set" || o.type === "add")).toBeUndefined();
  });

  it("emits set (full replace) when the type changed", () => {
    const w = widget("t1", { type: "chart" });
    const remote = new Map([["t1", { type: "kpi", spec: serializableSpec(widget("t1")), version: 1 }]]);
    const ops = widgetsToOps([w], remote);
    expect(ops).toContainEqual({ type: "set", widgetId: "t1", widgetType: "chart", spec: serializableSpec(w) });
  });

  it("emits remove for room widgets deleted locally", () => {
    const remote = new Map([["gone", { type: "kpi", spec: serializableSpec(widget("gone")), version: 1 }]]);
    const ops = widgetsToOps([widget("kept")], remote);
    expect(ops).toContainEqual({ type: "remove", widgetId: "gone" });
  });

  it("emits reorder when local order differs from the room", () => {
    const a = widget("a");
    const b = widget("b");
    const remote = new Map([
      ["a", { type: "kpi", spec: serializableSpec(a), version: 1 }],
      ["b", { type: "kpi", spec: serializableSpec(b), version: 1 }],
    ]);
    // Same content, different order → only a reorder op.
    const ops = widgetsToOps([b, a], remote, ["a", "b"]);
    expect(ops).toEqual([{ type: "reorder", order: ["b", "a"] }]);
  });
});

describe("applyRemoteWidgets — room state → local pages", () => {
  it("returns the SAME array when nothing changed (React referential stability)", () => {
    const w = widget("s1");
    const pages0 = page([w]);
    const remote = [{ widgetId: "s1", type: "kpi", spec: serializableSpec(w), version: 5 }];
    expect(applyRemoteWidgets(remote, pages0, "page-1")).toBe(pages0);
  });

  it("replaces a local widget with a newer remote version", () => {
    const local = widget("s2", { title: "Local" });
    const remoteSpec = serializableSpec(widget("s2", { title: "Remote" }));
    const next = applyRemoteWidgets(
      [{ widgetId: "s2", type: "kpi", spec: remoteSpec, version: 9 }],
      page([local]),
      "page-1",
    );
    expect(next[0]!.widgets[0]!.title).toBe("Remote");
  });

  it("appends remote widgets the local page has not seen (peer addition)", () => {
    const local = widget("mine");
    const theirs = serializableSpec(widget("theirs", { title: "Peer added" }));
    const next = applyRemoteWidgets(
      [
        { widgetId: "mine", type: "kpi", spec: serializableSpec(local), version: 2 },
        { widgetId: "theirs", type: "kpi", spec: theirs, version: 1 },
      ],
      page([local]),
      "page-1",
    );
    expect(next[0]!.widgets.map((w) => w.id)).toEqual(["mine", "theirs"]);
  });

  it("trusts the room on deletions: a locally-present widget missing remotely is removed", () => {
    const a = widget("a");
    const b = widget("b");
    const next = applyRemoteWidgets(
      [{ widgetId: "a", type: "kpi", spec: serializableSpec(a), version: 1 }],
      page([a, b]),
      "page-1",
    );
    expect(next[0]!.widgets.map((w) => w.id)).toEqual(["a"]);
  });

  it("keeps the local widget when the remote spec is unusable (honest fallback)", () => {
    const local = widget("u1", { title: "Keep me" });
    const next = applyRemoteWidgets(
      [{ widgetId: "u1", type: "kpi", spec: { broken: true }, version: 4 }],
      page([local]),
      "page-1",
    );
    expect(next[0]!.widgets[0]!.title).toBe("Keep me");
  });

  it("does not touch other pages", () => {
    const local = widget("p2w");
    const pages0: ReportPage[] = [
      { id: "page-1", name: "One", widgets: [widget("p1w")] },
      { id: "page-2", name: "Two", widgets: [local] },
    ];
    const next = applyRemoteWidgets(
      [{ widgetId: "p2w", type: "kpi", spec: serializableSpec(widget("p2w", { title: "New" })), version: 7 }],
      pages0,
      "page-2",
    );
    expect(next[0]).toBe(pages0[0]); // untouched page keeps identity
    expect(next[1]!.widgets[0]!.title).toBe("New");
  });
});
