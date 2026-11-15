import { TableSkeleton } from "@/components/ui/feedback";

/** Notifications list. */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <TableSkeleton rows={8} columns={4} />
    </div>
  );
}
