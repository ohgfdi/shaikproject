import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Empty state — friendly illustration + CTA (no blank screens ever).
 *
 * This module intentionally has no `"use client"` directive: server pages
 * render <EmptyState icon={SomeLucideIcon} … /> and passing a component
 * reference across a client boundary is not serializable. Being shared lets
 * both server and client trees render it without restrictions.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-muted ring-1 ring-line">
        <Icon aria-hidden className="size-7" />
      </span>
      <div>
        <p className="text-h3 text-foreground">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
