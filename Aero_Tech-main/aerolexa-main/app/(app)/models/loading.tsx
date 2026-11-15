import { GallerySkeleton } from "@/components/ui/feedback";

/** Trained models list — a card gallery. */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <GallerySkeleton items={6} />
    </div>
  );
}
