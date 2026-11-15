"use client";

/**
 * FigureProvenanceButton — the "figure → rows" drill-down.
 *
 * Renders a small "How were these rows chosen?" affordance on any chart
 * figure. Clicking opens a dialog with the deterministic recipe: aggregation,
 * grouping filter, contributing row count, the contributing rows themselves
 * (when the row store is loaded), and a recomputation verdict that verifies
 * the rendered value against the source rows.
 */

import { ListTree } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Table } from "@/components/ui/table";
import { figureProvenance, verifyFigureValue, type SourceColumns, type SourceRow } from "@/lib/provenance";
import type { ChartSpec } from "@/lib/types";

export function FigureProvenanceButton({
  spec,
  seriesName,
  category,
  renderedValue,
  columns,
  rows,
}: {
  spec: ChartSpec;
  seriesName: string;
  category: string;
  renderedValue: number;
  columns: SourceColumns;
  rows: SourceRow[] | null;
}) {
  const [open, setOpen] = useState(false);

  const prov = useMemo(
    () => figureProvenance(spec, seriesName, category, columns, rows),
    [spec, seriesName, category, columns, rows],
  );
  const verdict = useMemo(() => verifyFigureValue(prov, renderedValue), [prov, renderedValue]);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="Figure → rows provenance">
        <ListTree aria-hidden className="size-4" />
        <span className="sr-only">Show the source rows behind this figure value</span>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Figure → rows provenance">
        <div className="space-y-4 text-sm">
          <p className="text-caption text-muted">{prov.summary}</p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-caption">
            <dt className="text-muted">Figure</dt>
            <dd className="text-foreground">{prov.figureTitle}</dd>
            <dt className="text-muted">Series</dt>
            <dd className="text-foreground">{prov.series}</dd>
            <dt className="text-muted">Category</dt>
            <dd className="text-foreground">{prov.category}</dd>
            <dt className="text-muted">Aggregation</dt>
            <dd className="text-foreground">
              {prov.aggregation.fn.toUpperCase()}({prov.aggregation.column ?? "row"})
            </dd>
            <dt className="text-muted">Group filter</dt>
            <dd className="text-foreground">
              {prov.filter.groupColumn ? `${prov.filter.groupColumn} = "${prov.filter.groupValue}"` : "none"}
            </dd>
          </dl>

          <div aria-live="polite">
            {verdict === null ? (
              <p className="rounded border border-line bg-surface-2 px-3 py-2 text-caption text-muted">
                Source rows are not loaded in this view — the value shown is the engine&apos;s computed result. Load the
                dataset in the SQL Lab to verify against raw rows here.
              </p>
            ) : verdict ? (
              <p className="rounded border border-line bg-surface-2 px-3 py-2 text-caption text-foreground">
                ✓ Verified: recomputing {prov.aggregation.fn.toUpperCase()} over the {prov.rowCount} contributing rows
                reproduces the rendered value exactly.
              </p>
            ) : (
              <p className="rounded border border-line bg-surface-2 px-3 py-2 text-caption text-foreground">
                ✗ Mismatch — the rendered value does not reproduce from these rows. Investigate before trusting this
                figure.
              </p>
            )}
          </div>

          {prov.rows && prov.rows.length > 0 && prov.rows[0] && (
            <Table aria-label="Contributing source rows">
              <thead>
                <tr>
                  {Object.keys(prov.rows[0]).map((k) => (
                    <th key={k} className="p-2 text-caption font-semibold uppercase text-muted">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prov.rows.slice(0, 20).map((row, i) => (
                  <tr key={i} className="border-b border-line/60">
                    {Object.keys(prov.rows![0]!).map((k) => (
                      <td key={k} className="p-2 text-caption">
                        {row[k] === null || row[k] === undefined ? "—" : String(row[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Dialog>
    </>
  );
}
