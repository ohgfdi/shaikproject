"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "amber";
type Size = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  // Every variant carries a material: the primary is an accent surface (key
  // light through the brand tint), the rest are neutral convex solids. Shading
  // is layered on top of the flat colour, never instead of it, so the tokens
  // that carry text contrast stay exactly where the design system put them.
  primary: "mat-accent mat-raised bg-accent text-on-accent hover:bg-accent-strong disabled:hover:bg-accent font-medium",
  secondary: "mat-raised border border-line bg-surface text-foreground hover:bg-surface-2 font-medium",
  ghost: "mat-panel text-foreground hover:bg-surface-2 font-medium",
  // Destructive actions are solid, not tinted, in both themes: a 10% red wash
  // under a red label measured 1.64:1 in the light theme — the tint lifted the
  // background to nearly the label's own luminance. Solid fills also read as
  // "this is the dangerous one", which a ghost button never does. Because the
  // fill is a saturated colour rather than a page surface it also takes the
  // accent geometry (a specular band above the label) instead of a page-scale
  // wash, which would blow the fill out to near-white under the light theme's
  // key light. Label colours are contrast-picked per theme and pinned by
  // ui-materials.test.ts.
  danger:
    "mat-accent mat-raised border border-danger/40 bg-[#B3253C] text-white dark:border-danger/30 dark:bg-danger dark:text-black",
  amber: "mat-accent mat-raised bg-amber text-black hover:brightness-95 font-semibold",
};

const sizes: Record<Size, string> = {
  xs: "h-7 px-2 text-xs gap-1.5",
  sm: "h-8 px-2.5 text-sm gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-5 text-body gap-2",
};

const baseClasses =
  "inline-flex select-none items-center justify-center rounded-md transition-[background-color,box-shadow] duration-150 ease focus-visible:outline-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line focus-visible:active:scale-95 focus-visible:active:bg-opacity-90";

/** Shared class composition so <Button> and <ButtonLink> never drift. */
export function buttonClassnames({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return cn(baseClasses, variants[variant], sizes[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(buttonClassnames({ variant, size, className }), "disabled:cursor-not-allowed disabled:opacity-50")}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

/** A <Link> rendered with the same visual contract as <Button>. */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { href, variant = "primary", size = "md", icon, className, children, ...rest },
  ref,
) {
  return (
    <Link href={href} ref={ref} className={buttonClassnames({ variant, size, className })} {...rest}>
      {icon}
      {children}
    </Link>
  );
});

/** Minimal icon-only button with accessible label. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line",
        active && "bg-surface-2 text-foreground focus-visible:active:scale-95",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
