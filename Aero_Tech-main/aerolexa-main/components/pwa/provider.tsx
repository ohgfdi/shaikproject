"use client";

import { useEffect, useState, createContext, useContext, ReactNode } from "react";

import { offlineQueue } from "@/lib/pwa/offline-queue";

import { PWAInstallPrompt, usePWAInstall } from "./install-prompt";
import { OfflineIndicator, useOfflineStatus } from "./offline-indicator";
import { SWRegister, useSWUpdate } from "./sw-register";

interface PWAContextValue {
  isOnline: boolean;
  pendingCount: number;
  canInstall: boolean;
  isInstalled: boolean;
  updateAvailable: boolean;
  applyUpdate: () => void;
  promptInstall: () => Promise<boolean>;
  flushQueue: () => Promise<void>;
}

const PWAContext = createContext<PWAContextValue | null>(null);

export function PWAProvider({ children }: { children: ReactNode }) {
  const { isOnline, pendingCount, flushNow } = useOfflineStatus();
  const { canInstall, isInstalled, promptInstall } = usePWAInstall();
  const { updateAvailable, applyUpdate } = useSWUpdate();

  return (
    <PWAContext.Provider
      value={{
        isOnline,
        pendingCount,
        canInstall,
        isInstalled,
        updateAvailable,
        applyUpdate,
        promptInstall,
        flushQueue: flushNow,
      }}
    >
      <div style={{ minHeight: "100vh" }}>
        <SWRegister />
        <OfflineIndicator />
        <PWAInstallPrompt />
        {children}
      </div>
    </PWAContext.Provider>
  );
}

export function usePWA() {
  const context = useContext(PWAContext);
  if (!context) {
    throw new Error("usePWA must be used within a PWAProvider");
  }
  return context;
}

export function usePendingMutations() {
  const [mutations, setMutations] = useState<import("@/lib/pwa/offline-queue").OfflineMutation[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const unsubscribe = offlineQueue.subscribe(async () => {
      const { mutations: pending } = await offlineQueue.getQueueStatus();
      setMutations(pending);
    });

    offlineQueue.getQueueStatus().then(({ mutations: pending }) => setMutations(pending));

    return unsubscribe;
  }, []);

  return mutations;
}
