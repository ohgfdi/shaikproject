import { TableSkeleton } from "@/components/ui/feedback";

/** Audit log — a dense, wide table. */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <TableSkeleton rows={12} columns={6} />
    </div>
  );
}
