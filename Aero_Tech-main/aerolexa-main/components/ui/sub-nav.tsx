"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export interface SubNavItem {
  href: string;
  label: string;
  /** Match the href exactly; otherwise any child route counts as active. */
  exact?: boolean;
}

/** Secondary horizontal navigation between sibling routes (e.g. dataset → SQL lab → What-if). */
export function SubNav({ items, className, ...rest }: { items: SubNavItem[] } & React.HTMLAttributes<HTMLElement>) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      className={cn("mb-5 flex flex-wrap items-center gap-1 border-b border-line", className)}
      {...rest}
    >
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
