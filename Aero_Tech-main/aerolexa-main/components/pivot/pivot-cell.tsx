"use client";

import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/overlays";
import { Card } from "@/components/ui/primitives";
import { Table, TableHeader, TableRow, TableCell, TableBody } from "@/components/ui/table";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface PivotValueSpec {
  column: string;
  aggregation: "sum" | "count" | "avg" | "min" | "max";
}

/**
 * Pivot Table Cell (dashboards).
 *
 * Renders a real pivot aggregation over the widget's dataset, computed
 * server-side by the same engine path as the SQL Lab (DuckDB when enabled).
 * Every number shown comes from the dataset's actual rows — nothing is mocked.
 *
 * API contract: all parameters go in the POST body of
 * `POST /api/datasets/:id/pivot` (rows, columns, values), matching the
 * route's `readJsonBody` handler. The response returns flat grouped rows:
 * `{ rows: Cell[][], columns: string[] }` where the first `rows.length`
 * entries of each row are the group keys and the rest are the aggregations.
 */
export function PivotCell({
  datasetId,
  rows,
  columns,
  values,
  onCellClick,
}: {
  datasetId: string;
  rows: string[]; // group-by columns
  columns: string[]; // pivot columns (unique values) — included in the fetch payload
  values: PivotValueSpec[];
  onCellClick?: (rowValues: string[], columnValue: string) => void;
}) {
  const [data, setData] = useState<(string | number | null)[][]>([]);
  const [header, setHeader] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const valuesKey = values.map((v) => `${v.column}:${v.aggregation}`).join(",");

  useEffect(() => {
    let cancelled = false;
    async function loadPivotData() {
      if (!datasetId || rows.length === 0 || values.length === 0) {
        if (!cancelled) {
          setError("This pivot widget has no dataset or aggregation configured. Edit the dashboard to fix it.");
          setLoading(false);
        }
        return;
      }
      try {
        setLoading(true);
        const response = await fetch(`/api/datasets/${datasetId}/pivot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows, columns, values }),
        });
        if (!response.ok) {
          const errData = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
            message?: string;
          };
          const message =
            errData?.error?.message ??
            errData?.message ??
            "Failed to load pivot data — check that the configured columns still exist on the dataset.";
          throw new Error(message);
        }
        const result = (await response.json()) as { rows?: (string | number | null)[][]; columns?: string[] };
        if (cancelled) return;
        setData(result.rows ?? []);
        setHeader(result.columns ?? [...rows, ...values.map((v) => `${v.aggregation}(${v.column})`)]);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load pivot data";
        setError(message);
        toast({
          title: "Error loading pivot table",
          message,
          type: "error",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPivotData();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- valuesKey covers the values array
  }, [datasetId, rows.join(","), columns.join(","), valuesKey]);

  const handleCellClick = useCallback(
    (rowIdx: number, aggColIdx: number) => {
      if (!onCellClick) return;
      const rowValues = (data[rowIdx] ?? []).slice(0, rows.length).map((v) => String(v ?? ""));
      const columnValue = header[rows.length + aggColIdx] ?? "";
      onCellClick(rowValues, columnValue);
    },
    [data, header, rows.length, onCellClick],
  );

  if (loading) {
    return (
      <Card className="flex h-64 items-center justify-center">
        <span className="text-caption text-muted">Loading pivot table…</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="h-64 overflow-auto p-4">
        <span className="text-caption text-muted">{error}</span>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card className="flex h-64 items-center justify-center p-4 text-center">
        <span className="text-caption text-muted">
          No rows matched this pivot configuration — the dataset may be empty or the group-by columns have no values.
        </span>
      </Card>
    );
  }

  const groupCount = rows.length;
  const aggCount = Math.max(0, header.length - groupCount);

  return (
    <Card className="h-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableCell className="font-medium text-caption text-foreground">Group</TableCell>
            {header.slice(groupCount).map((col, i) => (
              <TableCell key={`${col}-${i}`} className="font-medium text-caption text-foreground">
                {col}
              </TableCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, rowIdx) => (
            <TableRow key={rowIdx}>
              <TableCell className="whitespace-nowrap font-medium text-caption text-foreground">
                {row
                  .slice(0, groupCount)
                  .map((v) => String(v ?? "—"))
                  .join(" · ")}
              </TableCell>
              {Array.from({ length: aggCount }, (_, aggIdx) => {
                const cellData = row[groupCount + aggIdx];
                const usable = cellData !== null && cellData !== undefined && cellData !== "";
                return (
                  <TableCell
                    key={aggIdx}
                    className={cn(
                      "p-2 text-caption tabular-nums",
                      onCellClick && "cursor-pointer hover:text-primary",
                      usable ? "text-foreground" : "text-muted bg-surface/20",
                    )}
                    onClick={onCellClick ? () => handleCellClick(rowIdx, aggIdx) : undefined}
                  >
                    {usable ? fmtNumber(Number(cellData)) : "—"}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export default PivotCell;
