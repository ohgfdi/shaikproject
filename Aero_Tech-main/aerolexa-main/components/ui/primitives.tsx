"use client";

import type { HTMLAttributes, ReactNode } from "react";

import { cn, readableTextOn } from "@/lib/utils";

/* Card — a convex panel in the DOM material system: lit from the upper left,
   shaded toward the lower right, with the ambient contact shadow that makes it
   sit on the page instead of float in front of it. The shading is layered over
   `.card`'s flat tokens, so every colour that carries text contrast is
   unchanged from the design system. */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card mat-panel", className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between gap-3 px-4 pt-4", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-h3 text-foreground", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-0.5 text-caption text-muted", className)} {...rest} />;
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 border-t border-line px-4 py-3", className)} {...rest} />;
}

/* Badge + severity colours (icon/text never colour-only). */

export type BadgeVariant = "default" | "accent" | "info" | "warning" | "critical" | "success" | "outline" | "amber";

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-surface-2 text-muted border border-line",
  accent: "bg-accent/12 text-accent-strong dark:text-[#7FC6C8] border border-accent/30",
  info: "bg-[#3D9BE9]/12 text-[#1E6FB5] dark:text-[#6FB8F0] border border-[#3D9BE9]/30",
  warning: "bg-[#F08A5D]/12 text-[#B85C22] dark:text-[#F5A878] border border-[#F08A5D]/30",
  critical: "bg-[#E8637A]/12 text-[#B93A52] dark:text-[#F08A9B] border border-[#E8637A]/30",
  success: "bg-[#58B368]/12 text-[#2E7D46] dark:text-[#7ED096] border border-[#58B368]/30",
  amber: "bg-amber/15 text-amber border border-amber/40",
  outline: "border border-line text-muted",
};

export function Badge({
  variant = "default",
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium",
        badgeVariants[variant],
        className,
      )}
      {...rest}
    />
  );
}

export function SeverityBadge({ severity, label }: { severity: "info" | "warning" | "critical"; label?: string }) {
  const map: Record<string, BadgeVariant> = { info: "info", warning: "warning", critical: "critical" };
  return <Badge variant={map[severity] ?? "default"}>{label ?? severity}</Badge>;
}

/* Skeleton loader */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("skeleton", className)} {...rest} />;
}

/* Spinner */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-5 animate-spin rounded-full border-2 border-line border-t-accent", className)}
    />
  );
}

/* Avatar — initials with stable colour from the name */
export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const palette = ["#5AA8AA", "#7C5CFF", "#3D9BE9", "#E8637A", "#58B368", "#F08A5D"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const bg = palette[h % palette.length] ?? "#5AA8AA";
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: size * 0.38,
        color: readableTextOn(bg),
      }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}

/* Linear progress */
export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* Brand logo mark */
export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className="flex size-7 items-center justify-center rounded-md bg-accent/15 ring-1 ring-accent/40"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M2 13V8.5" stroke="#5AA8AA" strokeWidth="2" strokeLinecap="round" />
          <path d="M6 13V3.5" stroke="#7FC6C8" strokeWidth="2" strokeLinecap="round" />
          <path d="M10 13V6" stroke="#5AA8AA" strokeWidth="2" strokeLinecap="round" />
          <path d="M14 13V2" stroke="#FFB400" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="text-h3 tracking-tight text-foreground">Ledgerly</span>}
    </span>
  );
}

export function BrandLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-caption font-medium uppercase tracking-wider text-muted", className)}>{children}</p>;
}
