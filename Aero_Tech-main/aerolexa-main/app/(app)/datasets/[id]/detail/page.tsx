import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/primitives";
import { DataTable, type DataColumn, type DataRow } from "@/components/ui/table";
import { requirePageAuth } from "@/lib/auth/guard";
import { parseDrillFilters } from "@/lib/engine/drill-through";
import { loadAuthorizedDataset } from "@/lib/server/dataset-access";

export const metadata = { title: "Drill-through detail" };
export const dynamic = "force-dynamic";

const MAX_FILTERS = 8;

/**
 * Drill-through detail page (ROADMAP 3.5).
 *
 * The target of `drillThroughUrl()` — a shareable, bookmarkable URL that
 * re-runs the SAME filter semantics the dashboard click produced, but over the
 * dataset's real rows. Every read flows through `loadAuthorizedDataset`, the
 * shared RLS chokepoint: a viewer with row-level-security rules sees exactly
 * the rows their dashboard tiles see, never more.
 *
 * Filters are DATA here (column/value strings from the `f=` params). They are
 * matched against the dataset's REAL columns — an unknown column matches no
 * rows and is surfaced honestly as "unmatched", never loosely interpreted.
 */
export default async function DatasetDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();

  const data = await loadAuthorizedDataset({ userId: ctx.user.id, workspaceId: ctx.workspace.id }, params.id);

  const filters = parseDrillFilters(searchParams.f).slice(0, MAX_FILTERS);
  const from = typeof searchParams.from === "string" ? searchParams.from.slice(0, 80) : null;

  // Column index for filter matching. Matching is exact on the string form of
  // the cell (the same normalization drill-through filters were derived from).
  const byColumn = new Map(data.columns.map((c, i) => [c.name, i]));
  const known = filters.filter((f) => byColumn.has(f.column));
  const unknown = filters.filter((f) => !byColumn.has(f.column));

  const matches = (row: (string | number | boolean | null)[]) =>
    known.every((f) => {
      const idx = byColumn.get(f.column);
      if (idx === undefined) return false;
      const cell = row[idx];
      return cell !== null && cell !== undefined && String(cell) === f.value;
    });

  const rows: DataRow[] = (data.rows as (string | number | boolean | null)[][])
    .filter(matches)
    .map((row) => row.map((cell) => (cell === null || cell === undefined ? null : (cell as string | number))));

  const columns: DataColumn[] = data.columns.map((c) => ({
    key: c.name,
    label: c.name,
    format: c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
  }));

  const filterSummary = known.map((f) => `${f.column} = ${f.value}`).join(" · ");

  return (
    <div>
      <PageHeader
        title={from ? `Detail — from “${from}”` : "Detail"}
        description={
          <>
            Underlying rows of{" "}
            <Link className="text-accent hover:underline" href={`/datasets/${data.datasetId}`}>
              {data.datasetName}
            </Link>{" "}
            {known.length > 0 ? (
              <>
                filtered to <strong className="font-medium text-foreground">{filterSummary}</strong>
              </>
            ) : (
              "(no filters applied)"
            )}
            {data.sampleNote}
          </>
        }
        actions={
          <Link
            href={`/datasets/${data.datasetId}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Back to dataset
          </Link>
        }
      />

      {/* Provenance — the trust bar: say exactly what produced these rows. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="success">Calculated</Badge>
        <span className="text-caption text-muted">
          {rows.length.toLocaleString()} matching row(s) · loaded {data.rowsLoaded.toLocaleString()} of{" "}
          {data.totalRows.toLocaleString()} stored row(s)
        </span>
        {data.applied && (
          <Badge variant="warning" title={data.restrictions.join("; ")}>
            RLS restricted view
          </Badge>
        )}
      </div>
      {data.note && <p className="mb-4 text-caption text-muted">{data.note}</p>}

      {unknown.length > 0 && (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-muted">
          {unknown.length} filter(s) referenced columns that do not exist in this dataset (
          {unknown.map((f) => f.column).join(", ")}) and were ignored — no rows were matched on them.
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        pageSize={25}
        maxHeight={560}
        numStyle="comma"
        caption={
          known.length > 0
            ? `Rows where ${filterSummary} — ${rows.length} of ${data.rowsLoaded.toLocaleString()} visible rows`
            : undefined
        }
      />
    </div>
  );
}
