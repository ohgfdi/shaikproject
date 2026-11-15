"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/ui/primitives";

/**
 * Route-level error boundary inside the (app) shell.
 * Renders in-place of the page content while preserving the AppShell chrome.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="rounded-lg border border-danger/40 bg-background shadow-sm">
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/10">
              <AlertTriangle aria-hidden className="size-5 text-danger" />
            </span>
            <div className="min-w-0">
              <h2 className="text-h3 text-foreground">This section hit a snag</h2>
              <p className="mt-1 text-sm text-muted">
                An unexpected error occurred while loading this view. Your data is safe.
              </p>
              {error.digest && (
                <p className="mt-2 rounded bg-surface px-2 py-1 font-mono text-[11px] text-muted">
                  Error ID: {error.digest}
                </p>
              )}
              <details className="mt-3">
                <summary className="cursor-pointer text-caption font-medium text-danger">What happened?</summary>
                <p className="mt-1.5 rounded bg-surface px-2.5 py-2 text-sm text-muted">{error.message}</p>
              </details>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-6 py-3">
          <Button variant="primary" icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={() => reset()}>
            Try again
          </Button>
          <ButtonLink href="/dashboard" variant="secondary">
            Back to dashboard
          </ButtonLink>
        </div>
      </div>
      <div className="mt-6 flex justify-center opacity-50">
        <Logo compact />
      </div>
    </div>
  );
}
