import type { LucideIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/primitives";
import { timeAgo } from "@/lib/format";

export interface ArtifactItem {
  id: string;
  title: string;
  sub?: string | null;
  href: string;
  updatedAt: Date;
}

export function ArtifactGrid({
  items,
  icon,
  emptyTitle,
  emptyDescription,
  createHref,
  createLabel,
}: {
  items: ArtifactItem[];
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  createHref?: string;
  createLabel?: string;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={icon}
          title={emptyTitle}
          description={emptyDescription}
          action={
            createHref ? (
              <Link href={createHref}>
                <Button size="sm">{createLabel ?? "Create"}</Button>
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        const Icon = icon;
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              className="card group flex h-full flex-col p-4 transition-shadow hover:shadow-pop"
              aria-label={`Open ${item.title}`}
            >
              <span
                aria-hidden
                className="flex size-10 items-center justify-center rounded-md bg-accent/12 text-accent"
              >
                <Icon className="size-5" />
              </span>
              <h2 className="mt-3 text-h3 text-foreground line-clamp-2">{item.title}</h2>
              {item.sub && <p className="mt-1 line-clamp-2 flex-1 text-sm text-muted">{item.sub}</p>}
              <p className="mt-3 text-caption text-muted">Updated {timeAgo(item.updatedAt)}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
