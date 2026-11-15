import { Compass } from "lucide-react";

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * 404 inside the (app) shell — keeps the sidebar visible while informing
 * the user the requested page does not exist.
 */
export default function AppNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you are looking for does not exist or has been moved."
        action={<ButtonLink href="/dashboard">Back to dashboard</ButtonLink>}
      />
    </div>
  );
}
