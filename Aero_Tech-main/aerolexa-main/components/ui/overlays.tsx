"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { uid } from "@/lib/utils";

/* ---------------------------------------------------------------------------
   Dialog
--------------------------------------------------------------------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStartY = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => closeRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      window.clearTimeout(t);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        aria-label="Close dialog"
        role="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Dialog"}
        onTouchStart={(e: ReactTouchEvent<HTMLDivElement>) => {
          touchStartY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(e: ReactTouchEvent<HTMLDivElement>) => {
          const start = touchStartY.current;
          touchStartY.current = null;
          if (start === null) return;
          const y = e.changedTouches[0]?.clientY;
          if (y !== undefined && y - start > 70) onClose();
        }}
        className={cn(
          "relative z-10 flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-lg border border-line bg-surface shadow-pop sm:rounded-lg animate-slide-up",
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-h3 text-foreground">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line active:scale-95 hover:bg-surface-2 hover:text-foreground"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Dropdown menu (trigger + popover items)
--------------------------------------------------------------------------- */

export interface DropdownItem {
  label: string;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

export function Dropdown({
  trigger,
  items,
  align = "right",
  label,
}: {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        previouslyFocused?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = idx;
    if (e.key === "ArrowDown") next = idx < items.length - 1 ? idx + 1 : 0;
    else if (e.key === "ArrowUp") next = idx > 0 ? idx - 1 : items.length - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    const target = items[next];
    target?.focus();
  };

  const toggle = () => setOpen((v) => !v);

  // The caller's own trigger element is the interactive control (never wrap it
  // in another focusable element — WCAG: no interactive-inside-interactive).
  const triggerElement = trigger as ReactElement<{ onClick?: (e: ReactMouseEvent<HTMLElement>) => void }>;
  const triggerWithProps = isValidElement(trigger)
    ? cloneElement(triggerElement as ReactElement<Record<string, unknown>>, {
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
          triggerElement.props.onClick?.(e);
          toggle();
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        "aria-label": label,
      })
    : null;

  return (
    <div ref={ref} className="relative inline-block">
      {triggerWithProps ?? (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={label}
          className="rounded text-left"
        >
          {trigger}
        </button>
      )}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute z-40 mt-1 min-w-44 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-pop animate-fade-in",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) => (
            <button
              key={`${item.label}-${i}`}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2 disabled:opacity-40",
                item.danger ? "text-danger" : "text-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Tooltip — CSS/group based, with aria-describedby support via wrapper
--------------------------------------------------------------------------- */

export function Tooltip({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <span className={cn("group/tt relative inline-flex", className)}>
      <span aria-describedby={id}>{children}</span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 w-max max-w-60 -translate-x-1/2 rounded-md border border-line bg-surface-3 px-2 py-1 text-caption text-foreground opacity-0 shadow-pop transition-opacity group-hover/tt:opacity-100 group-focus-within/tt:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Toasts
--------------------------------------------------------------------------- */

interface Toast {
  id: string;
  title: string;
  message?: string;
  type: "success" | "error" | "info";
}

const ToastContext = createContext<{ toast: (t: Omit<Toast, "id">) => void }>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = uid("toast");
    setToasts((prev) => [...prev, { ...t, id }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.type === "error" ? 8000 : 4200);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        role="region"
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 top-4 z-[80] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-surface px-3 py-2.5 shadow-pop animate-slide-up"
          >
            {t.type === "success" && <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />}
            {t.type === "error" && <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />}
            {t.type === "info" && <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{t.title}</p>
              {t.message && <p className="text-caption text-muted">{t.message}</p>}
            </div>
            <button
              aria-label="Dismiss notification"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="rounded p-0.5 text-muted hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
