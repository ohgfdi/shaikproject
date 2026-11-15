import { TableSkeleton } from "@/components/ui/feedback";

/**
 * Dataset overview — the parent of the query/whatif/transform tabs. Mixes KPI
 * tiles with a preview table, so the placeholder does both.
 */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <TableSkeleton rows={6} columns={5} />
    </div>
  );
}
