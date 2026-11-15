"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { NAV_LINKS } from "@/components/marketing/links";
import { ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Mobile navigation for the marketing site. A tiny client component on purpose:
 * native disclosure behaviour, Esc to close, focus returns to the trigger,
 * aria-expanded state. Desktop navigation stays server-rendered in app/page.tsx.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      trigger?.focus();
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="marketing-mobile-menu"
        aria-label={open ? "Close menu" : "Open menu"}
        className="inline-flex size-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-surface-2"
      >
        {open ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-sm"
          />
          <nav
            id="marketing-mobile-menu"
            aria-label="Mobile"
            className={cn(
              "absolute inset-x-3 top-3 animate-slide-up rounded-lg border border-line bg-surface p-3 shadow-pop",
            )}
          >
            <ul className="space-y-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="my-2 border-t border-line" />
            <div className="grid grid-cols-2 gap-2 px-1 pb-1">
              <ButtonLink href="/login" variant="secondary" size="lg" onClick={() => setOpen(false)}>
                Sign in
              </ButtonLink>
              <ButtonLink href="/signup" size="lg" onClick={() => setOpen(false)}>
                Get started
              </ButtonLink>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
