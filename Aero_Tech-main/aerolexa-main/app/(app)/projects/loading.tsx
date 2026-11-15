import { GallerySkeleton } from "@/components/ui/feedback";

/** Projects list — a card gallery; the hub itself is the slow part. */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <GallerySkeleton items={6} />
    </div>
  );
}
