"use client";

/**
 * Published notebook view (ROADMAP 4.4) — "mini dashboard", not read-only text.
 *
 * Upgrades over the old static renderer:
 *   - Widget cells render LIVE NotebookWidgetControls: a viewer changes a
 *     dropdown/number/date-range and the selected value becomes an active
 *     filter over every chart/table snapshot in the published notebook.
 *   - Chart outputs render through the real ChartRenderer (Apex/3D/custom
 *     suite) instead of text bars; sql-result and pivot outputs render as
 *     real tables; "Filtered by" chips show active selections with one-click
 *     clear — the same cross-filter UX as dashboards.
 *
 * Honesty rules preserved:
 *   - Code is NEVER executed on the viewer side. Filtering re-slices the
 *     PUBLISHED output snapshots through the same pure engines the dashboard
 *     uses (filterChartSpec / filterTableSpec). A filter that cannot be
 *     served from a snapshot shows that output unfiltered — never silently.
 *   - Clearing filters restores the exact published snapshot.
 */

import { useState } from "react";

import { ChartRenderer } from "@/components/charts/chart";
import { NotebookWidgetControl } from "@/components/notebook/notebook-input-widgets";
import { Badge, Card } from "@/components/ui/primitives";
import {
  filterChartSpec,
  filterTableSpec,
  toggleSelection,
  type CrossFilterSelection,
} from "@/lib/engine/cross-filter";
import { isConditionalTableOutput, isTableOutput } from "@/lib/engine/notebook-output";
import type { ViewerTierInfo } from "@/lib/scene/viewer-tier";
import type { NotebookCell, NotebookCellOutput, NotebookWidgetValue, PublishedNotebook, TableSpec } from "@/lib/types";

/**
 * Interactive published-notebook renderer, shared by:
 *   - /apps/[shareToken]        (public, no sign-in)
 *   - /published-notebook       (workspace-authenticated view)
 */
export function PublishedNotebookView({
  app,
  viewerTier: _viewerTier,
}: {
  app: PublishedNotebook;
  viewerTier?: ViewerTierInfo | null;
}) {
  const widgetCells = app.cells.filter((c) => c.kind === "widget" && c.widget);
  const [values, setValues] = useState<Record<string, NotebookWidgetValue>>(() => {
    const init: Record<string, NotebookWidgetValue> = {};
    for (const c of widgetCells) if (c.widget) init[c.widget.variable] = c.widget.value ?? null;
    return init;
  });
  const [selections, setSelections] = useState<CrossFilterSelection[]>([]);

  const hasWidgets = widgetCells.length > 0;
  const anyFilter = selections.length > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-h2 font-medium text-foreground">{app.title}</h1>
          <Badge variant="info">Published app</Badge>
          {app.accessMode === "public" && <Badge variant="outline">Public link</Badge>}
        </div>
        <p className="text-caption text-muted">
          {app.datasetName ? `Dataset: ${app.datasetName}` : "No dataset attached"}
          {app.publishedAt ? ` · published ${new Date(app.publishedAt).toLocaleDateString()}` : ""}
        </p>
      </div>

      {/* Interactive filter bar (ROADMAP 4.4): live widget controls */}
      {hasWidgets && (
        <Card className="mb-4 p-3">
          <div className="flex flex-wrap items-center gap-3">
            {widgetCells.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium text-foreground">{c.widget!.label ?? c.widget!.variable}</span>
                <NotebookWidgetControl
                  widget={{ ...c.widget!, value: values[c.widget!.variable] ?? null }}
                  onChange={(value) => {
                    const variable = c.widget!.variable;
                    setValues((v) => ({ ...v, [variable]: value }));
                    // The widget's chosen value becomes a cross-filter selection
                    // keyed to the widget cell, so it filters every OTHER cell.
                    if (value !== null && typeof value !== "object") {
                      setSelections((cur) =>
                        toggleSelection(cur, {
                          column: variable,
                          values: [String(value)],
                          sourceWidgetId: c.id,
                          sourceWidgetTitle: c.widget!.label ?? variable,
                        }),
                      );
                    } else {
                      // Cleared / range values cannot match snapshots by value —
                      // drop this widget's selection honestly.
                      setSelections((cur) => cur.filter((s) => s.sourceWidgetId !== c.id));
                    }
                  }}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-caption text-muted">
            Filters re-slice the published results below — code is never executed in the viewer.
          </p>
        </Card>
      )}

      {/* "Filtered by" chip bar — mirrors dashboard cross-filter UX */}
      {anyFilter && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {selections.flatMap((s) =>
            s.values.map((v) => (
              <button
                key={`${s.sourceWidgetId}-${s.column}-${v}`}
                type="button"
                onClick={() => setSelections((cur) => toggleSelection(cur, s))}
                className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-caption text-foreground hover:bg-accent/20"
              >
                {s.column}: {v}
                <span aria-hidden>×</span>
              </button>
            )),
          )}
          <button
            type="button"
            onClick={() => setSelections([])}
            className="ml-1 text-caption text-muted underline underline-offset-2 hover:text-foreground"
          >
            Clear all filters
          </button>
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {app.cells.length === 0 && (
          <Card className="p-6 text-center text-caption text-muted">This published notebook has no cells.</Card>
        )}
        {app.cells.map((cell, i) => {
          // Power BI semantics: the source of a selection stays unfiltered.
          const isSource = selections.some((s) => s.sourceWidgetId === cell.id);
          return (
            <PublishedCell
              key={cell.id}
              cell={cell}
              index={i}
              widgetValues={values}
              onWidgetChange={(variable, value) => setValues((v) => ({ ...v, [variable]: value }))}
              selections={isSource ? [] : selections}
              filtered={anyFilter && !isSource}
              onToggle={(sel) => setSelections((cur) => toggleSelection(cur, sel))}
            />
          );
        })}
      </ol>
    </div>
  );
}

function PublishedCell({
  cell,
  index,
  widgetValues,
  onWidgetChange,
  selections,
  filtered,
  onToggle,
}: {
  cell: NotebookCell;
  index: number;
  widgetValues: Record<string, NotebookWidgetValue>;
  onWidgetChange: (variable: string, value: NotebookWidgetValue) => void;
  selections: CrossFilterSelection[];
  filtered: boolean;
  onToggle: (sel: CrossFilterSelection) => void;
}) {
  return (
    <li className="card overflow-hidden">
      <div className="border-b border-line bg-surface px-3 py-1.5">
        <Badge variant={cell.kind === "code" ? "accent" : "outline"}>{cell.kind}</Badge>
        {cell.kind === "code" && <span className="ml-2 text-caption text-muted">Cell {index + 1} · read-only</span>}
        {filtered && <span className="ml-2 text-caption text-muted">filtered</span>}
      </div>
      {cell.kind === "widget" && cell.widget ? (
        <div className="flex flex-wrap items-center gap-3 bg-background px-3 py-3">
          <label className="text-sm font-medium text-foreground">{cell.widget.label ?? cell.widget.variable}</label>
          <NotebookWidgetControl
            widget={{ ...cell.widget, value: widgetValues[cell.widget.variable] ?? cell.widget.value ?? null }}
            onChange={(value) => onWidgetChange(cell.widget!.variable, value)}
          />
          <span className="text-caption text-muted">binds {`{{${cell.widget.variable}}}`}</span>
        </div>
      ) : cell.kind === "markdown" ? (
        <p className="whitespace-pre-wrap bg-background px-3 py-2 text-sm leading-relaxed text-foreground">
          {cell.content}
        </p>
      ) : (
        <pre className="thin-scroll overflow-x-auto bg-background px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap text-foreground">
          {cell.content}
        </pre>
      )}
      {cell.output && <PublishedOutput output={cell.output} selections={selections} onToggle={onToggle} />}
    </li>
  );
}

function PublishedOutput({
  output,
  selections,
  onToggle,
}: {
  output: NotebookCellOutput;
  selections: CrossFilterSelection[];
  onToggle: (sel: CrossFilterSelection) => void;
}) {
  if (output.type === "error") {
    return (
      <div role="alert" className="border-t border-danger/30 bg-danger/5 px-3 py-2.5 font-mono text-[13px] text-danger">
        {output.message}
      </div>
    );
  }
  if (output.type === "note") {
    return (
      <div className="border-t border-info/30 bg-info/5 px-3 py-2.5 text-sm">
        <p className="font-medium text-foreground">{output.title}</p>
        <p className="mt-1 text-muted">{output.detail}</p>
      </div>
    );
  }
  if (output.type === "stats") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-2 text-caption font-medium text-foreground">{output.title}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          {output.stats.map((s) => (
            <div key={s.label} className="text-sm">
              <dt className="text-caption text-muted">{s.label}</dt>
              <dd className="tabular-nums font-medium text-foreground" title={s.hint}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  if (output.type === "chart") {
    const chart = filterChartSpec(output.chart, selections);
    return (
      <div className="border-t border-line px-3 py-3">
        <ChartRenderer spec={chart} bare height={260} />
        {chart.categories && chart.categories.length > 0 && (
          <CategoryChips
            categories={chart.categories}
            onToggle={(value) =>
              onToggle({
                column: chart.xLabel ?? output.title,
                values: [value],
                sourceWidgetId: `chart:${output.title}`,
                sourceWidgetTitle: output.title,
              })
            }
          />
        )}
      </div>
    );
  }
  if (isTableOutput(output)) {
    const spec = filterTableSpec({ title: output.title, columns: output.columns, rows: output.rows }, selections);
    const didFilter = spec.rows.length !== output.rows.length;
    return (
      <PublishedTable
        spec={spec}
        note={didFilter ? `${spec.rows.length} of ${output.rows.length} published rows (filtered)` : undefined}
      />
    );
  }
  if (output.type === "image") {
    return (
      <div className="border-t border-line px-3 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:${output.image.mimeType};base64,${output.image.data}`}
          alt="Python chart output"
          className="h-auto max-w-full"
        />
      </div>
    );
  }
  if (output.type === "text") {
    return (
      <pre className="thin-scroll border-t border-line bg-background px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap text-foreground">
        {output.text}
      </pre>
    );
  }
  if (output.type === "sql-result") {
    const spec = filterTableSpec(
      {
        title: output.title,
        columns: output.columns.map((c) => ({ key: c.name, label: c.name })),
        rows: output.rows.map((r) => r.map((v) => (v === null ? null : (v as string | number)))),
      },
      selections,
    );
    const didFilter = spec.rows.length !== output.rows.length;
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-1 text-sm font-medium text-foreground">{output.title}</p>
        <p className="mb-2 text-caption text-muted">
          {didFilter
            ? `${spec.rows.length} of ${output.rowCount} published rows (filtered) · ${output.engine}`
            : `${output.rowCount} rows · ${output.engine} · ${output.executionMs} ms`}
        </p>
        <PublishedTable spec={spec} scroll />
        <p className="mt-2 text-caption text-muted">{output.note}</p>
      </div>
    );
  }
  if (output.type === "pivot-result") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-2 text-sm font-medium text-foreground">{output.title}</p>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-caption text-muted">
              <tr>
                <th className="px-3 py-1.5" />
                {output.columnHeaders.map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {output.rowHeaders.map((rh, i) => (
                <tr key={rh}>
                  <th className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-foreground">{rh}</th>
                  {output.data[i]?.map((v, j) => (
                    <td key={j} className="whitespace-nowrap px-3 py-1.5 tabular-nums text-foreground">
                      {v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString() : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (output.type === "map-result") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="mb-2 text-sm font-medium text-foreground">{output.title}</p>
        <p className="text-caption text-muted">
          {output.points.length} point(s) — interactive map preview is not part of the published snapshot.
        </p>
      </div>
    );
  }
  if (isConditionalTableOutput(output)) {
    return (
      <div className="thin-scroll border-t border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-caption text-muted">
            <tr>
              {output.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-1.5 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {output.rows.map((row, i) => (
              <tr key={i}>
                {output.columns.map((c, j) => {
                  const style = output.cellStyles[`${i}:${j}`] ?? {};
                  return (
                    <td
                      key={c.key}
                      className="whitespace-nowrap px-3 py-1.5 text-foreground"
                      style={{ backgroundColor: style.bg, color: style.color }}
                    >
                      {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // Exhaustive over the known output types — any future type surfaces here.
  return <div className="border-t border-line px-3 py-2.5 text-sm text-muted">Output rendered</div>;
}

function PublishedTable({ spec, note, scroll }: { spec: TableSpec; note?: string; scroll?: boolean }) {
  return (
    <div className="border-t border-line">
      {note && <p className="border-b border-line bg-surface-2/60 px-3 py-1 text-caption text-muted">{note}</p>}
      <div className={`thin-scroll ${scroll ? "max-h-80 overflow-auto" : "overflow-x-auto"}`}>
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-caption text-muted">
            <tr>
              {spec.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-1.5 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {spec.rows.map((row, i) => (
              <tr key={i}>
                {spec.columns.map((c, j) => (
                  <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-foreground">
                    {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
                  </td>
                ))}
              </tr>
            ))}
            {spec.rows.length === 0 && (
              <tr>
                <td colSpan={spec.columns.length} className="px-3 py-4 text-center text-caption text-muted">
                  No rows match the active filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoryChips({ categories, onToggle }: { categories: string[]; onToggle: (value: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {categories.slice(0, 24).map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => onToggle(cat)}
          className="rounded-full border border-line px-2 py-0.5 text-caption text-muted hover:border-accent/40 hover:text-foreground"
          title={`Filter everything else by “${cat}”`}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
