import { TableSkeleton } from "@/components/ui/feedback";

/**
 * Dataset detail loads the full parsed profile server-side (column stats,
 * quality warnings, sample rows) — the slowest (app) route. A table-shaped
 * placeholder matches the arriving content instead of the generic block.
 */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <TableSkeleton rows={10} columns={6} />
    </div>
  );
}
