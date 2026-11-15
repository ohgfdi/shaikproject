"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number;
}

export function Tabs({
  items,
  active,
  onChange,
  children,
  className,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  children?: ReactNode;
  className?: string;
}) {
  const baseId = useId();
  return (
    <div className={className}>
      <div role="tablist" aria-label="Sections" className="flex flex-wrap items-center gap-1 border-b border-line">
        {items.map((item) => {
          const selected = item.key === active;
          return (
            <button
              key={item.key}
              role="tab"
              id={`${baseId}-tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.key)}
              onKeyDown={(e) => {
                const idx = items.findIndex((i) => i.key === item.key);
                let next: number | null = null;
                if (e.key === "ArrowRight") next = (idx + 1) % items.length;
                if (e.key === "ArrowLeft") next = (idx - 1 + items.length) % items.length;
                if (next !== null) {
                  e.preventDefault();
                  onChange(items[next]!.key);
                }
              }}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                selected ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {item.label}
              {typeof item.count === "number" && (
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-caption tabular-nums text-muted">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${active}`}
        aria-labelledby={`${baseId}-tab-${active}`}
        className="pt-4"
      >
        {children}
      </div>
    </div>
  );
}
