"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground">
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-lg border border-danger/40 bg-background shadow-sm">
            <div className="p-6">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/10">
                  <AlertTriangle aria-hidden className="size-5 text-danger" />
                </span>
                <div className="min-w-0">
                  <h1 className="text-h3 text-foreground">Something went wrong</h1>
                  <p className="mt-1 text-sm text-muted">An unexpected error occurred. Your data is safe.</p>
                  {error.digest && (
                    <p className="mt-2 rounded bg-surface px-2 py-1 font-mono text-[11px] text-muted">
                      Error ID: {error.digest}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-line px-6 py-3">
              <Button variant="primary" icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={() => reset()}>
                Try again
              </Button>
              <ButtonLink href="/" variant="secondary">
                Go home
              </ButtonLink>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
