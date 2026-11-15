"use client";

import { useEffect, useState, useCallback } from "react";

import { offlineQueue } from "@/lib/pwa/offline-queue";

export function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    setIsOnline(navigator.onLine);
    offlineQueue.getPendingCount().then(setPendingCount);

    const unsubscribe = offlineQueue.subscribe(setPendingCount);

    const handleOnline = () => {
      setIsOnline(true);
      offlineQueue.flushQueue();
    };

    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    offlineQueue.subscribe((count) => {
      setSyncing(count > 0 && isOnline);
    });

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [isOnline]);

  if (isOnline && pendingCount === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 9997,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: isOnline ? "#1e293b" : "#7f1d1d",
        border: isOnline ? "1px solid #0ea5e9" : "1px solid #ef4444",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
        fontSize: 12,
        color: isOnline ? "#0ea5e9" : "#fca5a5",
        animation: "slideDown 0.2s ease-out",
      }}
      role="status"
      aria-live="polite"
    >
      <style jsx>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

      {syncing ? (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: "spin 1s linear infinite" }}
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Syncing {pendingCount} change{pendingCount !== 1 ? "s" : ""}...
        </>
      ) : isOnline ? (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          {pendingCount} pending change{pendingCount !== 1 ? "s" : ""} — will sync
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          Offline — {pendingCount} change{pendingCount !== 1 ? "s" : ""} queued
        </>
      )}
    </div>
  );
}

export function useOfflineStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    setIsOnline(navigator.onLine);
    offlineQueue.getPendingCount().then(setPendingCount);

    const unsubscribe = offlineQueue.subscribe(setPendingCount);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const flushNow = useCallback(async () => {
    if (!isOnline) return;
    await offlineQueue.flushQueue();
  }, [isOnline]);

  return { isOnline, pendingCount, flushNow };
}
