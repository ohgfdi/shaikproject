"use client";

import { AlertTriangle, FlaskConical, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/*
 * "Prototype / Demo" badge — for results computed with prototype or
 * demonstration logic only.
 *
 * Do NOT use on SciPy-validated analysis results (EDA, KPI, distribution,
 * correlation, trend). Those are computed by the statistically-validated
 * engine and compared against SciPy oracles in CI.
 *
 * Use on: demonstration/synthetic paths only (demo dataset insights,
 * geo tiles without a map service, kernel-failure notebook states). The
 * statistical engines (EDA, KPI, forecast, what-if, ML training) are
 * oracle-tested and must NOT carry this badge.
 */
export function DemoBadge({
  tooltip = "Computed by a demonstration path, not a validated engine — every result here is labelled exactly, never guessed.",
  compact = false,
}: {
  tooltip?: string;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="amber" className="cursor-help">
        <FlaskConical aria-hidden className="size-3" />
        {compact ? "Demo" : "Prototype / Demo"}
      </Badge>
      <span className="sr-only text-caption">{tooltip}</span>
    </span>
  );
}

/* Self-hosted indicator — emphasizes data ownership and deployment flexibility. */
export function SelfHostedBadge({ className }: { className?: string }) {
  return (
    <Badge variant="amber" className={cn("align-middle", className)}>
      <svg aria-hidden className="size-4 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5" />
      </svg>
      Self-hosted
    </Badge>
  );
}

/* Warning banner — used for data-quality issues, dismissible. */
export function WarningBanner({
  title,
  children,
  onDismiss,
  severity = "warning",
  className,
}: {
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
  severity?: "warning" | "info" | "critical";
  className?: string;
}) {
  const Icon = severity === "critical" ? ShieldAlert : severity === "info" ? TriangleAlert : AlertTriangle;
  return (
    <div
      role={severity === "critical" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm",
        severity === "critical" && "border-danger/40 bg-danger/10 text-danger",
        severity === "warning" && "border-warning/40 bg-warning/10 text-foreground",
        severity === "info" && "border-info/40 bg-info/10 text-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-muted">{children}</div>}
      </div>
      {onDismiss && (
        <Button variant="ghost" size="xs" onClick={onDismiss} aria-label="Dismiss warning">
          Dismiss
        </Button>
      )}
    </div>
  );
}

/* Inline error with "What happened?" + "How to fix" + retry. */
export function ErrorMessage({
  title = "Something went wrong",
  message,
  howToFix,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  howToFix?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const explanation = message ?? "An unexpected error occurred while loading this view.";
  return (
    <div role="alert" className={cn("rounded-md border border-danger/40 bg-danger/5 p-4", className)}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <details className="mt-1.5 text-sm">
            <summary className="cursor-pointer text-caption font-medium text-danger">What happened?</summary>
            <p className="mt-1 rounded bg-surface px-2.5 py-2 text-muted">{explanation}</p>
          </details>
          {howToFix && (
            <p className="mt-2 text-sm text-muted">
              <span className="font-medium text-foreground">How to fix:</span> {howToFix}
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-3">
          <RefreshCw aria-hidden className="size-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}

/* Error boundary — friendly message, never a raw stack trace. */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallbackTitle?: string; onReset?: () => void },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): { hasError: boolean; message: string } {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In production this would go to the configured error tracker. Never render the stack.
    console.error("[ErrorBoundary]", error.message, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="p-4">
        <ErrorMessage
          title={this.props.fallbackTitle ?? "This section hit a snag"}
          message="A runtime error occurred inside this view. Your data is safe."
          howToFix="Reload the page, or try the action again. If it persists, check the data quality warnings on the dataset."
          onRetry={() => {
            this.setState({ hasError: false, message: "" });
            this.props.onReset?.();
          }}
        />
      </div>
    );
  }
}

/* Full-screen loading skeleton pattern. */
export function LoadingSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-between">
        <div className="skeleton h-6 w-44" />
        <div className="skeleton h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-28 rounded-md" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`r${i}`} className="skeleton h-40 rounded-md" />
      ))}
    </div>
  );
}

/**
 * Skeleton for a data table — used by per-route loading.tsx files so the
 * placeholder has the SHAPE of what is arriving (rows + columns) instead of
 * one generic block. A layout that matches the final content measurably
 * reduces the perceived jump when the real rows land.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div aria-busy="true" aria-live="polite" className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-between">
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-9 w-28" />
      </div>
      <div className="card mat-panel overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {Array.from({ length: columns }).map((_, c) => (
              <div key={`h${c}`} className="skeleton h-3.5 w-full" />
            ))}
          </div>
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={`r${r}`} className="border-b border-line/60 px-4 py-3 last:border-b-0">
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {Array.from({ length: columns }).map((_, c) => (
                <div key={`c${c}`} className="skeleton h-3.5 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for a card gallery (artifact grids: projects, reports, models…).
 * Responsive by construction — 1/2/3 columns — so the placeholder reflows at
 * the same breakpoints as the real grid.
 */
export function GallerySkeleton({ items = 6, className }: { items?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-between">
        <div className="skeleton h-6 w-44" />
        <div className="skeleton h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: items }).map((_, i) => (
          <div key={i} className="card mat-panel p-4">
            <div className="skeleton h-4 w-3/4" />
            <div className="mt-2 skeleton h-3 w-full" />
            <div className="mt-1.5 skeleton h-3 w-2/3" />
            <div className="mt-4 skeleton h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
