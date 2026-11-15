"use client";

/**
 * Schema Browser panel.
 *
 * Equivalent to Hex's schema browser: shows dataset columns, types, profiling
 * stats, and top values. Used in the SQL Lab sidebar and notebook context.
 */

import { ChevronDown, ChevronRight, Copy, Info, Search, Table2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { apiCached, errorMessage, CACHE_POLICIES } from "@/lib/client/api";

interface ColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  distinct: number;
  missing: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  topValues?: { value: string; count: number }[];
  nearConstant: boolean;
  minDate?: string;
  maxDate?: string;
  outlierCount?: number;
}

interface SchemaInfo {
  datasetId: string;
  datasetName: string;
  isDemo: boolean;
  rowCount: number;
  columnCount: number;
  columns: ColumnDetail[];
  qualityWarnings: string[];
}

interface SchemaBrowserProps {
  datasetId: string;
  /** Called when user clicks a column name to insert it into the editor. */
  onInsertColumn?: (columnName: string) => void;
  /** Show compact mode (for notebook sidebar). */
  compact?: boolean;
}

export function SchemaBrowser({ datasetId, onInsertColumn, compact }: SchemaBrowserProps) {
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedCol, setExpandedCol] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // A dataset's schema is read-mostly reference data: many notebook cells,
      // the SQL prefill and the studio all ask for it, and it only changes
      // when the dataset is re-uploaded. Cached for 30s (see CACHE_POLICIES).
      const data = await apiCached<{ schema: SchemaInfo }>(
        `/api/datasets/${datasetId}/schema`,
        CACHE_POLICIES.datasetMeta,
      );
      setSchema(data.schema);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [datasetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="p-3">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3">
        <p className="text-sm text-danger">{error}</p>
        <Button size="xs" variant="secondary" onClick={() => void load()} className="mt-2">
          Retry
        </Button>
      </div>
    );
  }

  if (!schema) return null;

  const filtered = search
    ? schema.columns.filter((col) => col.name.toLowerCase().includes(search.toLowerCase()))
    : schema.columns;

  return (
    <div className={`flex flex-col ${compact ? "h-full" : ""}`}>
      {/* Header */}
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <Table2 aria-hidden className="size-4 text-accent" />
          <h3 className="text-sm font-medium text-foreground truncate">{schema.datasetName}</h3>
          {schema.isDemo && <Badge variant="warning">demo</Badge>}
        </div>
        <p className="mt-1 text-caption text-muted">
          {schema.rowCount.toLocaleString()} rows · {schema.columnCount} columns
        </p>
      </div>

      {/* Search */}
      <div className="border-b border-line px-3 py-2">
        <div className="relative">
          <Search aria-hidden className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns…"
            className="h-8 w-full rounded-md border border-line bg-surface pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
          />
        </div>
      </div>

      {/* Quality warnings */}
      {schema.qualityWarnings.length > 0 && (
        <div className="border-b border-line bg-warning/5 px-3 py-2">
          <div className="flex items-center gap-1.5 text-caption text-warning">
            <Info aria-hidden className="size-3.5" />
            <span>{schema.qualityWarnings.length} quality warning(s)</span>
          </div>
        </div>
      )}

      {/* Column list */}
      <div className="flex-1 overflow-y-auto thin-scroll">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-caption text-muted">No columns match {`"${search}"`}</p>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((col) => (
              <li key={col.name}>
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <button
                    onClick={() => setExpandedCol(expandedCol === col.name ? null : col.name)}
                    className="flex items-center gap-1 text-foreground hover:text-accent"
                    aria-expanded={expandedCol === col.name}
                  >
                    {expandedCol === col.name ? (
                      <ChevronDown aria-hidden className="size-3" />
                    ) : (
                      <ChevronRight aria-hidden className="size-3" />
                    )}
                    <span className="text-sm font-medium truncate">{col.name}</span>
                  </button>
                  <Badge variant="outline" className="ml-auto shrink-0">
                    {col.type}
                  </Badge>
                  {col.nullable && (
                    <Badge variant="outline" className="shrink-0">
                      ?
                    </Badge>
                  )}
                  {onInsertColumn && (
                    <button
                      onClick={() => onInsertColumn(col.name)}
                      className="shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-foreground"
                      title={`Insert ${col.name}`}
                      aria-label={`Insert column ${col.name}`}
                    >
                      <Copy aria-hidden className="size-3" />
                    </button>
                  )}
                </div>

                {/* Expanded details */}
                {expandedCol === col.name && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted">Distinct</dt>
                      <dd className="text-foreground">
                        {col.distinct === -1 ? "many" : col.distinct.toLocaleString()}
                      </dd>
                      <dt className="text-muted">Missing</dt>
                      <dd className="text-foreground">{col.missing.toLocaleString()}</dd>
                      {col.min !== undefined && (
                        <>
                          <dt className="text-muted">Min</dt>
                          <dd className="text-foreground">
                            {typeof col.min === "number" ? col.min.toLocaleString() : col.min}
                          </dd>
                        </>
                      )}
                      {col.max !== undefined && (
                        <>
                          <dt className="text-muted">Max</dt>
                          <dd className="text-foreground">
                            {typeof col.max === "number" ? col.max.toLocaleString() : col.max}
                          </dd>
                        </>
                      )}
                      {col.mean !== undefined && (
                        <>
                          <dt className="text-muted">Mean</dt>
                          <dd className="text-foreground">
                            {col.mean.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </dd>
                        </>
                      )}
                      {col.median !== undefined && (
                        <>
                          <dt className="text-muted">Median</dt>
                          <dd className="text-foreground">
                            {col.median.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </dd>
                        </>
                      )}
                      {col.minDate && (
                        <>
                          <dt className="text-muted">Min date</dt>
                          <dd className="text-foreground">{col.minDate}</dd>
                        </>
                      )}
                      {col.maxDate && (
                        <>
                          <dt className="text-muted">Max date</dt>
                          <dd className="text-foreground">{col.maxDate}</dd>
                        </>
                      )}
                      {col.outlierCount !== undefined && col.outlierCount > 0 && (
                        <>
                          <dt className="text-muted">Outliers</dt>
                          <dd className="text-warning">{col.outlierCount.toLocaleString()}</dd>
                        </>
                      )}
                    </dl>

                    {/* Top values for categorical columns */}
                    {col.topValues && col.topValues.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs font-medium text-muted">Top values</p>
                        <ul className="mt-1 space-y-0.5">
                          {col.topValues.map((tv) => (
                            <li key={tv.value} className="flex items-center gap-2 text-xs">
                              <span className="truncate text-foreground">{tv.value}</span>
                              <span className="ml-auto tabular-nums text-muted">{tv.count.toLocaleString()}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {col.nearConstant && (
                      <p className="mt-1 text-xs text-warning">Near-constant column (&gt;99.5% identical values)</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
