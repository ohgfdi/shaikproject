import { LoadingSkeleton } from "@/components/ui/feedback";

/**
 * Shared loading state for all (app) page transitions.
 * Renders inside the AppShell, so the sidebar stays visible.
 */
export default function Loading() {
  return (
    <div className="px-6 py-8" aria-busy="true" aria-live="polite">
      <LoadingSkeleton rows={4} />
    </div>
  );
}
