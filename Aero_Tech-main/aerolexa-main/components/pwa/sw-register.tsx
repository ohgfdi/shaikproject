"use client";

import { useEffect, useState, useCallback } from "react";
import { Workbox } from "workbox-window";

interface SWUpdateInfo {
  available: boolean;
  installing: boolean;
  installed: boolean;
}

export function SWRegister() {
  const [updateInfo, setUpdateInfo] = useState<SWUpdateInfo>({
    available: false,
    installing: false,
    installed: false,
  });
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  const applyUpdate = useCallback(async () => {
    if (registration?.waiting) {
      setUpdateInfo((prev) => ({ ...prev, installing: true }));
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  }, [registration]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const wb = new Workbox("/sw.js");

    wb.addEventListener("installed", (event) => {
      if (!event.isUpdate) {
        console.log("[SW] Service worker installed for first time");
        setUpdateInfo((prev) => ({ ...prev, installed: true }));
        return;
      }

      console.log("[SW] Service worker update available");
      setUpdateInfo((prev) => ({ ...prev, available: true, installed: true }));
    });

    wb.addEventListener("waiting", () => {
      console.log("[SW] Service worker waiting to activate");
      setUpdateInfo((prev) => ({ ...prev, available: true }));
    });

    wb.addEventListener("controlling", () => {
      console.log("[SW] Service worker controlling page - reloading");
      window.location.reload();
    });

    // workbox-window emits these two for a worker this instance does not manage
    // (i.e. another script taking over scope "/"), but its published typings
    // omit them — so the names go through one explicitly typed narrow hole.
    const onExternalEvent = (type: "externalinstalled" | "externalwaiting", log: string) => {
      (wb.addEventListener as unknown as (type: string, listener: () => void) => void)(type, () => console.log(log));
    };
    onExternalEvent("externalinstalled", "[SW] External service worker installed");
    onExternalEvent("externalwaiting", "[SW] External service worker waiting");

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (navigator.serviceWorker.controller) {
        window.location.reload();
      }
    });

    wb.register()
      .then((reg) => {
        // Workbox types the resolved value as possibly undefined (a worker the
        // page does not control); there is nothing to track in that case.
        if (!reg) {
          console.warn("[SW] Service worker registered without a registration handle");
          return;
        }
        console.log("[SW] Service worker registered:", reg.scope);
        setRegistration(reg);
      })
      .catch((error) => {
        console.error("[SW] Service worker registration failed:", error);
      });

    return () => {
      wb.removeEventListener("installed", () => {});
      wb.removeEventListener("waiting", () => {});
      wb.removeEventListener("controlling", () => {});
    };
  }, [applyUpdate]);

  if (typeof window === "undefined") return null;

  return (
    <>
      {updateInfo.available && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 9999,
            background: "#0f172a",
            border: "1px solid #0ea5e9",
            borderRadius: 12,
            padding: 16,
            boxShadow: "0 10px 40px rgba(14, 165, 233, 0.3)",
            maxWidth: 360,
          }}
          role="alert"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: "linear-gradient(135deg, #0ea5e9, #6366f1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                <path d="M23 21v-4h-4" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 600, color: "#f8fafc", fontSize: 14 }}>Update Available</p>
              <p style={{ margin: 4, fontSize: 12, color: "#94a3b8" }}>
                A new version of Ledgerly is ready. Refresh to apply.
              </p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={applyUpdate}
                style={{
                  padding: "8px 16px",
                  background: "linear-gradient(135deg, #0ea5e9, #6366f1)",
                  color: "white",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Refresh
              </button>
              <button
                onClick={() => setUpdateInfo((prev) => ({ ...prev, available: false }))}
                style={{
                  padding: "8px 12px",
                  background: "transparent",
                  color: "#94a3b8",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function useSWUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handleUpdate = () => setUpdateAvailable(true);
    navigator.serviceWorker.addEventListener("controllerchange", handleUpdate);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleUpdate);
    };
  }, []);

  const applyUpdate = useCallback(async () => {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    }
  }, []);

  return { updateAvailable, applyUpdate };
}
