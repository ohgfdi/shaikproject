"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { fmtDate, fmtNumber, fmtPct } from "@/lib/format";
import type { NumberFormatSetting } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("thin-scroll overflow-x-auto rounded-md border border-line", className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function TableHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn("bg-surface-2 text-caption font-semibold uppercase text-muted", className)}>{children}</thead>
  );
}

export function TableRow({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("border-b border-line/60", className)}>{children}</tr>;
}

export function TableCell({
  children,
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { className?: string }) {
  return (
    <td className={cn("p-2 text-caption", className)} {...rest}>
      {children}
    </td>
  );
}

export function TableBody({ children, className: _className }: { children: ReactNode; className?: string }) {
  return <tbody>{children}</tbody>;
}

export function Th({ children, className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-surface-2 px-3 py-2 text-caption font-semibold uppercase tracking-wide text-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("border-b border-line/60 px-3 py-2 align-top", className)} {...rest}>
      {children}
    </td>
  );
}

export interface DataColumn {
  key: string;
  label: string;
  format?: "number" | "pct" | "date" | "text";
}

export type DataRow = (string | number | null)[];

function formatCell(col: DataColumn, value: string | number | null, numStyle: NumberFormatSetting): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted/70">—</span>;
  if (col.format === "number" && typeof value === "number")
    return fmtNumber(value, { style: numStyle, maximumFractionDigits: 2 });
  if (col.format === "pct" && typeof value === "number") return fmtPct(value, 1, numStyle);
  if (col.format === "date" && typeof value === "string") return fmtDate(value);
  return String(value);
}

/**
 * Paginated data table used for analysis result tables and the data preview.
 * Paginates at > 20 rows (keeping DOM light for > 100-row tables).
 */
export function DataTable({
  columns,
  rows,
  numStyle = "comma",
  pageSize = 20,
  caption,
  maxHeight,
  className,
  rowKey,
}: {
  columns: DataColumn[];
  rows: DataRow[];
  numStyle?: NumberFormatSetting;
  pageSize?: number;
  caption?: string;
  maxHeight?: number;
  className?: string;
  rowKey?: (row: DataRow, i: number) => string;
}) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const [page, setPage] = useState(0);
  const [all] = useState(rows.length <= pageSize * 3);
  useEffect(() => setPage(0), [rows.length]);

  const visible = useMemo(() => {
    if (all) return rows;
    const start = page * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize, all]);

  if (columns.length === 0) return null;

  return (
    <div className={className}>
      {caption && <p className="mb-1 text-caption font-medium text-muted">{caption}</p>}
      <div
        className={cn("thin-scroll overflow-x-auto rounded-md border border-line", maxHeight && "overflow-y-auto")}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table
          className="w-full border-collapse text-left text-sm"
          aria-label={caption ?? columns.map((c) => c.label).join(", ")}
        >
          <thead>
            <tr>
              {columns.map((c) => (
                <Th key={c.key}>{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-muted">
                  No rows to show.
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr key={rowKey?.(row, i) ?? i} className="hover:bg-surface-2/50">
                  {columns.map((c, ci) => (
                    <Td key={c.key} className={cn("whitespace-nowrap", ci === 0 && "font-medium")}>
                      {formatCell(c, row[ci] as never, numStyle)}
                    </Td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {rows.length > pageSize && !all && (
        <div className="mt-2 flex items-center justify-between text-caption text-muted">
          <span aria-live="polite">
            {page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} of {rows.length.toLocaleString()}
          </span>
          <span className="flex items-center gap-1">
            <button
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded p-1 hover:bg-surface-2 disabled:opacity-40"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <span aria-hidden>
              {page + 1} / {pageCount}
            </span>
            <button
              aria-label="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="rounded p-1 hover:bg-surface-2 disabled:opacity-40"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
