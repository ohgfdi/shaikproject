"use client";

import { Bell, ChevronLeft, ChevronRight, LogOut, Menu, Search, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { CommandPalette } from "@/components/layout/command-palette";
import { isNavActive, navGroupsFor, type ShellNavGroup, type ShellNavItem } from "@/components/layout/nav-config";
import { WorkspaceBackdrop } from "@/components/ui/backdrop-3d";
import { ErrorBoundary } from "@/components/ui/feedback";
import { Dropdown } from "@/components/ui/overlays";
import { Avatar, Logo } from "@/components/ui/primitives";
import { migrateBrandStorage } from "@/lib/brand";
import { api } from "@/lib/client/api";
import { classifySwipe, type SwipeDirection } from "@/lib/client/touch-gestures";
import { cn } from "@/lib/utils";

export interface ShellUser {
  id: string;
  name: string;
  email: string;
  profileRole: string | null;
}

/**
 * Browser preference key. Namespaced (never the legacy `aerolexa.*`) and read
 * inside try/catch: private mode and blocked storage must render the expanded
 * rail, not crash the shell.
 */
const COLLAPSE_KEY = "ledgerly.sidebar-collapsed";

export function AppShell({
  user,
  unread,
  moduleFlags = {},
  children,
}: {
  user: ShellUser;
  unread: number;
  /** Frozen-module switches from featureFlags(); a frozen module shows in nav only when true. */
  moduleFlags?: Partial<Record<string, boolean>>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const mobileOpenRef = useRef(false);
  mobileOpenRef.current = mobileOpen;

  const groups = useMemo(() => navGroupsFor(moduleFlags), [moduleFlags]);

  useEffect(() => {
    // One-time forward-migration of any pre-rename `aerolexa.*` browser storage
    // to `ledgerly.*`. Idempotent, and a no-op once the legacy keys are gone.
    migrateBrandStorage();
  }, []);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // Storage unavailable: the documented default is expanded.
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Preference simply won't persist; the current session still collapses.
      }
      return next;
    });
  }, []);

  // The drawer is a route-level navigation surface: choosing a destination
  // closes it, which also restores focus to the trigger.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Drawer: body scroll lock, inert background, focus trap, Escape to close.
  useEffect(() => {
    if (!mobileOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    const background = document.getElementById("app-content");
    document.body.style.overflow = "hidden";
    background?.setAttribute("inert", "");
    const focusables = () =>
      Array.from(
        drawer?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 30);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = "";
      background?.removeAttribute("inert");
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [mobileOpen]);

  // Edge-swipe gestures are kept (existing behaviour): swipe right from the
  // left edge opens the drawer; swipe left closes it. Vertical/ambiguous moves
  // are rejected by classifySwipe so scrolling never triggers navigation.
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) return;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    };
    const onEnd = (event: TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const direction: SwipeDirection | null =
        classifySwipe(start, { x: touch.clientX, y: touch.clientY })?.direction ?? null;
      if (direction === "right" && start.x < 24) setMobileOpen(true);
      else if (direction === "left" && mobileOpenRef.current) setMobileOpen(false);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }, [router]);

  const accountItems = useMemo(
    () => [
      {
        label: "Settings",
        icon: <Settings aria-hidden className="size-4" />,
        onSelect: () => router.push("/settings"),
      },
      {
        label: "Sign out",
        icon: <LogOut aria-hidden className="size-4" />,
        danger: true,
        onSelect: signOut,
      },
    ],
    [router, signOut],
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <WorkspaceBackdrop />
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Desktop rail — 256px expanded / 72px collapsed, both driven by the
          same width utilities that set the content offset so they cannot drift. */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-surface",
          "transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex motion-reduce:duration-100",
          "w-64 md:w-68",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-line",
            collapsed ? "justify-center px-1" : "px-3.5",
          )}
        >
          <Link
            href="/dashboard"
            aria-label="Ledgerly — home"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Logo compact={collapsed} />
          </Link>
        </div>

        <SidebarNav groups={groups} collapsed={collapsed} />

        <div className={cn("shrink-0 border-t border-line", collapsed ? "p-2" : "p-3")}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className={cn(
              "flex min-h-10 w-full items-center gap-3 rounded-md text-sm text-muted transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line",
              "hover:bg-surface-2 hover:text-foreground hover:cursor-pointer",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            {collapsed ? (
              <ChevronRight aria-hidden className="size-5 shrink-0" />
            ) : (
              <>
                <ChevronLeft aria-hidden className="size-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Mobile drawer — only below md, so the rail and the drawer can never be
          mounted together. Rendered conditionally: zero duplicate labels when closed. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div aria-hidden className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div
            id="app-mobile-nav"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-surface shadow-pop"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
              <Link href="/dashboard" aria-label="Ledgerly — home" onClick={() => setMobileOpen(false)}>
                <Logo />
              </Link>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation menu"
                className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X aria-hidden className="size-5" />
              </button>
            </div>
            <SidebarNav groups={groups} collapsed={false} onNavigate={() => setMobileOpen(false)} />
            <div className="shrink-0 border-t border-line p-3">
              <Dropdown
                label="Account menu"
                trigger={
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Avatar name={user.name} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
                      <span className="block truncate text-caption text-muted">{user.profileRole ?? user.email}</span>
                    </span>
                  </button>
                }
                items={accountItems}
              />
            </div>
          </div>
        </div>
      )}

      <div
        id="app-content"
        className={cn(
          "relative z-10 flex min-w-0 flex-1 flex-col",
          "transition-[padding] duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "md:pl-[72px]" : "md:pl-64",
        )}
      >
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-background/90 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={mobileOpen}
            aria-controls="app-mobile-nav"
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line md:hidden"
          >
            <Menu aria-hidden className="size-5" />
          </button>
          <Link href="/dashboard" className="md:hidden" aria-label="Ledgerly — home">
            <Logo compact />
          </Link>

          <div className="ml-auto flex items-center gap-1">
            {/* One search control for the whole app: the existing command palette. */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("aerolexa:command-palette"))}
              className="flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-muted transition-colors hover:border-line/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-72 sm:px-3"
              aria-label="Search (opens command palette)"
              aria-keyshortcuts="Meta+K Control+K"
            >
              <Search aria-hidden className="size-4 shrink-0" />
              <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">Search…</span>
              <kbd className="hidden rounded border border-line px-1.5 text-caption sm:inline">⌘K</kbd>
            </button>

            <Link
              href="/notifications"
              aria-label={`Notifications (${unread} unread)`}
              className={cn(
                "relative inline-flex size-9 items-center justify-center rounded-md transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                pathname.startsWith("/notifications")
                  ? "bg-surface-2 text-foreground"
                  : "text-muted hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <Bell aria-hidden className="size-5" />
              {unread > 0 && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-amber text-[10px] font-bold text-black"
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Link>

            <LocaleSwitcher className="hidden sm:inline-flex" />

            <Dropdown
              label="Account menu"
              trigger={
                <button
                  type="button"
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line"
                >
                  <Avatar name={user.name} size={32} className="ring-1 ring-line" />
                </button>
              }
              items={accountItems}
            />
          </div>
        </header>

        <main
          id="main-content"
          className="no-hscroll mx-auto w-full max-w-[1600px] flex-1 px-6 py-8 sm:px-8 lg:px-10"
          role="main"
        >
          <ErrorBoundary fallbackTitle="Something went wrong with this page" onReset={() => window.location.reload()}>
            {children}
          </ErrorBoundary>
        </main>

        <footer className="border-t border-line px-4 py-3 text-center text-caption text-muted" role="contentinfo">
          Ledgerly prototype · Demo logic is always labelled ·{" "}
          <Link
            href="/settings?tab=data"
            className="underline decoration-line underline-offset-2 hover:text-foreground"
          >
            Data preferences
          </Link>
        </footer>
      </div>

      <CommandPalette moduleFlags={moduleFlags} />
    </div>
  );
}

/**
 * The one navigation landmark. Group headings are real text when expanded and
 * dividers when collapsed; every row is exactly one link with one icon, so a
 * label can never appear twice. Collapsed tooltips appear on hover AND keyboard
 * focus (the label remains the accessible name via aria-label).
 */
function SidebarNav({
  groups,
  collapsed,
  onNavigate,
}: {
  groups: ShellNavGroup[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    // tabIndex=0: the rail scrolls when the item list exceeds the viewport, and a
    // scrollable region must be reachable by keyboard (axe's
    // `scrollable-region-focusable` rule).
    <nav
      aria-label="Primary"
      tabIndex={0}
      className="flex-1 overflow-y-auto max-h-[calc(100vh_60px)] px-2.5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line"
    >
      {groups.map((group) => (
        <div key={group.id} className={collapsed ? "py-1" : "pb-1"}>
          {collapsed ? (
            <div role="separator" aria-hidden className="mx-2 my-2 border-t border-line" />
          ) : (
            <h2
              data-nav-group={group.id}
              className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted"
            >
              {group.label}
            </h2>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <SidebarLink
                key={item.href}
                item={item}
                active={isNavActive(pathname, item.href)}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <li className="relative">
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? item.label : undefined}
        className={cn(
          "group relative flex min-h-10 items-center gap-3 rounded-md text-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          collapsed ? "justify-center px-0" : "px-3",
          active ? "bg-accent/12 font-medium text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
        )}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
        )}
        <Icon aria-hidden className="size-5 shrink-0" />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {collapsed && (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface-3 px-2 py-1 text-caption text-foreground shadow-pop group-hover:block group-focus-visible:block"
          >
            {item.label}
          </span>
        )}
      </Link>
    </li>
  );
}
