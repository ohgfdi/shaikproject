"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface InstallPromptState {
  canInstall: boolean;
  isInstalled: boolean;
  dismissed: boolean;
  platform: "ios" | "android" | "desktop" | "unknown";
}

export function PWAInstallPrompt({
  onInstall,
  onDismiss,
  showAfterSeconds = 30,
  onlyShowOnce = true,
}: {
  onInstall?: () => void;
  onDismiss?: () => void;
  showAfterSeconds?: number;
  onlyShowOnce?: boolean;
}) {
  const [state, setState] = useState<InstallPromptState>({
    canInstall: false,
    isInstalled: false,
    dismissed: false,
    platform: "unknown",
  });
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setState((prev) => {
        if (prev.dismissed || prev.isInstalled) return prev;
        return { ...prev, canInstall: true };
      });
    }, showAfterSeconds * 1000);
  }, [showAfterSeconds]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

    setState((prev) => ({
      ...prev,
      platform: isIOS ? "ios" : isAndroid ? "android" : "desktop",
      isInstalled: isStandalone,
    }));

    if (isStandalone) return;

    if (onlyShowOnce && localStorage.getItem("pwa-install-dismissed")) {
      setState((prev) => ({ ...prev, dismissed: true }));
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setState((prev) => ({ ...prev, canInstall: true }));
      startTimer();
    };

    const handleAppInstalled = () => {
      setState((prev) => ({ ...prev, isInstalled: true, canInstall: false }));
      if (deferredPromptRef.current) {
        deferredPromptRef.current = null;
      }
      onInstall?.();
      localStorage.setItem("pwa-installed", "true");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    if (!isIOS && !isStandalone && !deferredPromptRef.current) {
      startTimer();
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [onInstall, onDismiss, showAfterSeconds, onlyShowOnce, startTimer]);

  const handleInstall = async () => {
    if (!deferredPromptRef.current) return;

    const promptEvent = deferredPromptRef.current;
    deferredPromptRef.current = null;

    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;

    if (outcome === "accepted") {
      setState((prev) => ({ ...prev, canInstall: false }));
      onInstall?.();
    } else {
      setState((prev) => ({ ...prev, canInstall: false, dismissed: true }));
      if (onlyShowOnce) localStorage.setItem("pwa-install-dismissed", "true");
      onDismiss?.();
    }
  };

  const handleDismiss = () => {
    setState((prev) => ({ ...prev, canInstall: false, dismissed: true }));
    if (onlyShowOnce) localStorage.setItem("pwa-install-dismissed", "true");
    onDismiss?.();
  };

  const handleIOSInstall = () => {
    setState((prev) => ({ ...prev, canInstall: false, dismissed: true }));
    if (onlyShowOnce) localStorage.setItem("pwa-install-dismissed", "true");
    onDismiss?.();
  };

  if (!state.canInstall || state.isInstalled || state.dismissed) return null;

  const isIOS = state.platform === "ios";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: 24,
        right: 24,
        maxWidth: 420,
        margin: "0 auto",
        zIndex: 9998,
        background: "#0f172a",
        border: "1px solid #0ea5e9",
        borderRadius: 16,
        padding: 20,
        boxShadow: "0 20px 60px rgba(14, 165, 233, 0.25)",
        animation: "slideUp 0.3s ease-out",
      }}
      role="dialog"
      aria-label="Install Ledgerly"
    >
      <style jsx>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: "0 8px 24px rgba(14, 165, 233, 0.4)",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#f8fafc", fontSize: 15 }}>Install Ledgerly</p>
          <p style={{ margin: 0, fontSize: 13, color: "#94a3b8", lineHeight: 1.5 }}>
            {isIOS
              ? 'Tap Share → "Add to Home Screen" for instant access offline.'
              : "Get faster access, offline support & native app experience."}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={isIOS ? handleIOSInstall : handleInstall}
            style={{
              padding: "10px 16px",
              background: isIOS ? "#1e293b" : "linear-gradient(135deg, #0ea5e9, #6366f1)",
              color: isIOS ? "#0ea5e9" : "white",
              border: isIOS ? "1px solid #0ea5e9" : "none",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseOver={(e) => {
              if (!isIOS) e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseOut={(e) => {
              if (!isIOS) e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {isIOS ? "Show Me How" : "Install App"}
          </button>

          <button
            onClick={handleDismiss}
            style={{
              padding: "8px 12px",
              background: "transparent",
              color: "#64748b",
              border: "1px solid #334155",
              borderRadius: 10,
              fontSize: 13,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "#94a3b8";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "#64748b";
            }}
          >
            Not Now
          </button>
        </div>
      </div>

      {isIOS && (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            background: "rgba(14, 165, 233, 0.1)",
            border: "1px solid rgba(14, 165, 233, 0.2)",
            borderRadius: 10,
            fontSize: 12,
            color: "#0ea5e9",
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "#38bdf8" }}>iOS Installation:</strong> Tap the Share button (□↑) at bottom of Safari
          → scroll down → Add to Home Screen → Add
        </div>
      )}
    </div>
  );
}

export function usePWAInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setCanInstall(false);
      deferredPromptRef.current = null;
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPromptRef.current) return false;

    await deferredPromptRef.current.prompt();
    const { outcome } = await deferredPromptRef.current.userChoice;

    if (outcome === "accepted") {
      setCanInstall(false);
      return true;
    }
    return false;
  }, []);

  return { canInstall, isInstalled, promptInstall };
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}
