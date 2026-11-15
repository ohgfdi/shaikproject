"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import {
  addField,
  aggregationMeta,
  canAggregate,
  drillPathLabels,
  emptyFieldState,
  findFieldWell,
  moveField,
  PIVOT_AGGREGATIONS,
  pivotRequestBody,
  removeField,
  setValueAggregation,
  type DrillFilter,
  type PivotAggregation,
  type PivotField,
  type PivotFieldState,
} from "@/lib/engine/pivot-grid";
import { cn } from "@/lib/utils";

/**
 * PivotFieldBuilder — the drag-drop field well editor for pivot tables.
 *
 * All state mutations go through the pure engine in lib/engine/pivot-grid.ts
 * (addField / removeField / moveField / setValueAggregation), so the wells a
 * user arranges here are exactly the `{rows, columns, values}` payload the
 * pivot API route consumes (via pivotRequestBody). Numbers come from the
 * server — this component only edits the shape of the query.
 *
 * Interaction: drag a field onto a well (HTML5 drag-drop) or use the
 * keyboard-accessible per-field move menu. Values-well entries carry an
 * aggregation that can be switched in place, gated by canAggregate so a
 * "sum" of a text column is never offered.
 */
export function PivotFieldBuilder({
  fields,
  value,
  onChange,
  onApply,
  applyLabel = "Add pivot to dashboard",
  datasetName,
  drillPath: drillPathProp,
  onDrillChange,
}: {
  /** Columns offered to the builder (name + inferred type). */
  fields: PivotField[];
  /** Current well state (controlled). */
  value: PivotFieldState;
  onChange: (next: PivotFieldState) => void;
  /** Called with the current state when the user applies. */
  onApply?: (state: PivotFieldState) => void;
  applyLabel?: string;
  /** Optional dataset label shown in the header. */
  datasetName?: string;
  /** Drill filters scoping the pivot to a drilled cell (controlled or internal). */
  drillPath?: DrillFilter[];
  /** Notified when the drill breadcrumb changes (e.g. a cell was clicked). */
  onDrillChange?: (path: DrillFilter[]) => void;
}) {
  const [dragField, setDragField] = useState<string | null>(null);
  const [internalDrill, setInternalDrill] = useState<DrillFilter[]>([]);
  const drillPath = drillPathProp ?? internalDrill;
  const setDrillPath = (path: DrillFilter[]) => {
    setInternalDrill(path);
    onDrillChange?.(path);
  };

  const typeOf = (name: string): PivotField["type"] => fields.find((f) => f.name === name)?.type ?? "string";

  const request = pivotRequestBody(value, drillPath);

  const wellTarget = (well: keyof PivotFieldState) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const name = e.dataTransfer.getData("text/plain") || dragField;
      if (!name) return;
      const from = findFieldWell(value, name);
      if (from) onChange(moveField(value, from, well, name));
      else onChange(addField(value, well, name, typeOf(name)));
      setDragField(null);
    },
  });

  const FieldChip = ({ name }: { name: string }) => {
    // Click-to-place: numbers go to Values (sum), everything else to Rows.
    // Drag-drop is the primary interaction in a browser; this is the
    // keyboard/screen-reader accessible path to the same engine calls.
    const place = () => {
      const well: keyof PivotFieldState = typeOf(name) === "number" ? "values" : "rows";
      if (findFieldWell(value, name)) return;
      onChange(addField(value, well, name, typeOf(name)));
    };
    return (
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", name);
          e.dataTransfer.effectAllowed = "move";
          setDragField(name);
        }}
        onDragEnd={() => setDragField(null)}
        onClick={place}
        title={`${name} (${typeOf(name)}) — click to place, or drag onto a well`}
        className={cn(
          "cursor-grab rounded-full border border-line bg-surface px-2.5 py-1 text-caption text-foreground transition-colors hover:border-accent",
          dragField === name && "opacity-50",
        )}
      >
        {name}
      </button>
    );
  };

  const WellList = ({ well }: { well: keyof PivotFieldState }) => {
    const items = well === "values" ? value.values.map((v) => v.column) : value[well];
    return (
      <div
        role="list"
        aria-label={`${well} well`}
        {...wellTarget(well)}
        className={cn(
          "min-h-16 rounded-md border border-dashed border-line p-2",
          dragField && "border-accent bg-accent/5",
        )}
      >
        {items.length === 0 ? (
          <p className="py-2 text-caption text-muted">
            {well === "values" ? "Drop a numeric field here to aggregate it." : `Drag fields here for the ${well}.`}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {well === "values"
              ? value.values.map((v) => {
                  const meta = aggregationMeta(v.aggregation);
                  const allowed = PIVOT_AGGREGATIONS.filter((a) => canAggregate(a.id, typeOf(v.column)));
                  return (
                    <span
                      key={v.column}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", v.column);
                        setDragField(v.column);
                      }}
                      className="flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2 py-1 text-caption text-foreground"
                    >
                      {v.column}
                      <select
                        aria-label={`Aggregation for ${v.column}`}
                        value={v.aggregation}
                        onChange={(e) =>
                          onChange(setValueAggregation(value, v.column, e.target.value as PivotAggregation))
                        }
                        className="rounded border border-line bg-surface text-caption focus:outline-none"
                      >
                        {allowed.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${v.column} from values`}
                        onClick={() => onChange(removeField(value, v.column))}
                        className="text-muted hover:text-danger"
                      >
                        ×
                      </button>
                      {meta?.numericOnly && typeOf(v.column) !== "number" && (
                        <span className="text-danger" title="This aggregation needs a numeric column.">
                          !
                        </span>
                      )}
                    </span>
                  );
                })
              : items.map((name) => (
                  <span
                    key={name}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", name);
                      e.dataTransfer.effectAllowed = "move";
                      setDragField(name);
                    }}
                    onDragEnd={() => setDragField(null)}
                    title={`${name} (${typeOf(name)}) — drag to another well, or remove`}
                    className={cn(
                      "flex cursor-grab items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-caption text-foreground",
                      dragField === name && "opacity-50",
                    )}
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name} from ${well}`}
                      onClick={() => onChange(removeField(value, name))}
                      className="text-muted hover:text-danger"
                    >
                      ×
                    </button>
                  </span>
                ))}
          </div>
        )}
      </div>
    );
  };

  const unplaced = fields.filter((f) => findFieldWell(value, f.name) === null);

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">
          Pivot field builder{datasetName ? ` · ${datasetName}` : ""}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange(emptyFieldState());
            setDrillPath([]);
          }}
        >
          Clear wells
        </Button>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5" role="list" aria-label="Available fields">
        {unplaced.length === 0 ? (
          <p className="text-caption text-muted">All fields are placed. Drag a chip out of a well to free it.</p>
        ) : (
          unplaced.map((f) => <FieldChip key={f.name} name={f.name} />)
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-caption font-medium text-muted">Rows</p>
          <WellList well="rows" />
        </div>
        <div>
          <p className="mb-1 text-caption font-medium text-muted">Columns</p>
          <WellList well="columns" />
        </div>
        <div>
          <p className="mb-1 text-caption font-medium text-muted">Values</p>
          <WellList well="values" />
        </div>
      </div>

      {/* Drill-down breadcrumb: click a row group in the rendered pivot to expand. */}
      {drillPath.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-muted">Drill path:</span>
          {drillPathLabels(drillPath).map((label, i) => (
            <span key={`${label}-${i}`} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-caption">
              {label}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setDrillPath(drillPath.slice(0, -1))}
            className="text-caption text-accent hover:underline"
          >
            ← up one level
          </button>
        </div>
      )}

      {request.error ? (
        <p className="mt-2 text-caption text-muted">{request.error}</p>
      ) : (
        <>
          <p className="mt-2 text-caption text-muted">
            Query: group by {[...drillPath.map((f) => f.column), ...request.rows].join(", ") || "—"}
            {request.columns.length > 0 ? ` × ${request.columns.join(", ")}` : ""} · aggregate{" "}
            {request.values.map((v) => `${v.aggregation}(${v.column})`).join(", ")}
          </p>
          {onApply && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={() => onApply(value)}>
                {applyLabel}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default PivotFieldBuilder;
