"use client";

import { AlertTriangle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Required for non-destructive confirms (e.g. "Clear notifications"). */
  defaultDanger?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface OpenDialog extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/**
 * Accessible confirmation dialog for destructive / irreversible actions.
 *
 * Usage:
 *   const { confirm } = useConfirm();
 *   const ok = await confirm({
 *     title: "Delete dataset?",
 *     message: "Rows, analyses, and notebooks on this dataset will be removed.",
 *     confirmLabel: "Delete",
 *   });
 *   if (!ok) return;
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setDialog({ ...options, resolve });
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      dialog?.resolve(result);
      setDialog(null);
    },
    [dialog],
  );

  useEffect(() => {
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close(false);
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
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus();
    };
  }, [dialog, close]);

  const isDanger = dialog?.danger ?? dialog?.defaultDanger ?? true;

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={() => close(false)} />
          <div
            ref={panelRef}
            className="relative w-full max-w-md rounded-lg border border-line bg-background p-5 shadow-xl"
          >
            <div className="flex items-start gap-3">
              {isDanger && (
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                    isDanger ? "bg-danger/10" : "bg-surface-2"
                  }`}
                >
                  <AlertTriangle aria-hidden className={`size-5 ${isDanger ? "text-danger" : "text-muted"}`} />
                </span>
              )}
              <div className="min-w-0">
                <h2 id="confirm-title" className="text-h3 text-foreground">
                  {dialog.title}
                </h2>
                {dialog.message && <div className="mt-1 text-sm text-muted">{dialog.message}</div>}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" ref={cancelRef} onClick={() => close(false)}>
                {dialog.cancelLabel ?? "Cancel"}
              </Button>
              <Button variant={isDanger ? "danger" : "secondary"} autoFocus={false} onClick={() => close(true)}>
                {dialog.confirmLabel ?? "Delete"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx)
    throw new Error(
      "useConfirm must be used within <ConfirmProvider>. What happened: the useConfirm hook was called outside of a ConfirmProvider. How to fix: wrap your application (or at least the component using useConfirm) with <ConfirmProvider>.",
    );
  return ctx;
}
