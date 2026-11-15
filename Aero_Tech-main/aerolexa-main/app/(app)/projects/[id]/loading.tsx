import { GallerySkeleton } from "@/components/ui/feedback";

/**
 * Project hub — resolves the project, its datasets, artifacts, counts and
 * membership before the tab panel can render, so it gets its own placeholder
 * instead of the shared one.
 */
export default function Loading() {
  return (
    <div className="px-6 py-8">
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
        <div className="skeleton h-7 w-56" />
        <div className="flex flex-wrap gap-1 border-b border-line pb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-24 rounded-md" />
          ))}
        </div>
      </div>
      <div className="mt-6">
        <GallerySkeleton items={3} />
      </div>
    </div>
  );
}
