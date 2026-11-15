"use client";

import { Download, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import { BRAND_STORAGE_KEYS, brandLocalStorageKey } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Mobile/PWA enhancements (client chrome):
 *  - Offline indicator: an honest banner whenever the browser loses
 *    connectivity — the service worker serves the offline shell, but the
 *    user should never mistake a cached page for live data.
 *  - Install prompt: surfaces the browser's beforeinstallprompt once per
 *    session (never on every page load) so installed-web-app adoption can
 *    grow without nagging. Chrome/Edge fire the event; Safari users install
 *    via the share sheet, so iOS only gets the hint when standalone-eligible.
 *
 * Both pieces are render-noop until the relevant browser condition is real,
 * and neither blocks interaction when shown.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = brandLocalStorageKey(BRAND_STORAGE_KEYS.installDismissed);

export function PwaEnhancements() {
  const [offline, setOffline] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  // Connectivity: honest live status, not a guess.
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Install prompt + session-scoped dismissal.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* private mode — treat as not dismissed */
    }
    setDismissed(false);

    const onPrompt = (e: Event) => {
      // Prevent the browser's own mini-infobar; we own the UX.
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const install = async () => {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
      await installEvent.userChoice;
    } catch {
      /* user agent refused — stay silent */
    }
    setInstallEvent(null);
  };

  const dismissInstall = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* non-persistent contexts simply re-prompt next session */
    }
  };

  return (
    <>
      {offline && (
        <div
          role="status"
          className="sticky top-14 z-30 flex items-center justify-center gap-2 border-b border-line bg-amber/15 px-4 py-1.5 text-caption text-foreground backdrop-blur"
        >
          <WifiOff aria-hidden className="size-3.5 text-amber" />
          You&apos;re offline — pages may be cached, but live data needs a connection.
        </div>
      )}
      {installEvent && !dismissed && (
        <div
          role="dialog"
          aria-label="Install Ledgerly"
          className={cn(
            "fixed inset-x-3 bottom-16 z-40 mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-line",
            "bg-surface px-4 py-3 shadow-pop sm:hidden", // mobile-first: the install surface that matters
          )}
        >
          <Download aria-hidden className="size-5 shrink-0 text-accent" />
          <p className="min-w-0 flex-1 text-caption text-foreground">
            Install Ledgerly for full-screen analytics and offline access.
          </p>
          <button type="button" onClick={() => void install()} className="shrink-0 text-sm font-semibold text-accent">
            Install
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            aria-label="Dismiss install prompt"
            className="shrink-0 text-caption text-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

export default PwaEnhancements;
