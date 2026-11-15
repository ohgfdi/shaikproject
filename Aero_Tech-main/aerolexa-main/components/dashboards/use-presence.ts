"use client";

/**
 * Dashboard presence client (ROADMAP 7.2).
 *
 * Subscribes to GET /api/dashboards/[id]/presence (SSE), keeps the peer list,
 * and sends widget-focus heartbeats. Mirrors the notebook collab hook's
 * minimal integration contract:
 *
 *   const presence = useDashboardPresence(dashboardId, enabled);
 *   presence.peers        — live peer list (others viewing this dashboard)
 *   presence.setWidget(id)— report the widget the user is focused on
 *   presence.connected    — SSE stream established
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface PresencePeer {
  id: string;
  name: string;
  color: string;
  lastSeen: number;
  widgetId?: string;
}

export function useDashboardPresence(dashboardId: string | null, enabled: boolean) {
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const peerIdRef = useRef<string | null>(null);
  const widgetRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!dashboardId || !enabled) return;
    const es = new EventSource(`/api/dashboards/${dashboardId}/presence`);

    es.addEventListener("hello", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { peerId: string; color: string; peers: PresencePeer[] };
      peerIdRef.current = data.peerId;
      setPeers(data.peers ?? []);
      setConnected(true);
    });
    es.addEventListener("peers", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { peers: PresencePeer[] };
      setPeers(data.peers ?? []);
    });
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      peerIdRef.current = null;
      setConnected(false);
      setPeers([]);
    };
  }, [dashboardId, enabled]);

  // Self-heartbeat so the registry TTL never drops an open tab.
  useEffect(() => {
    if (!dashboardId || !enabled) return;
    const timer = setInterval(() => {
      if (!peerIdRef.current) return;
      fetch(`/api/dashboards/${dashboardId}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peerIdRef.current, widgetId: widgetRef.current }),
        keepalive: true,
      }).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [dashboardId, enabled]);

  const setWidget = useCallback(
    (widgetId: string | undefined) => {
      const changed = widgetRef.current !== widgetId;
      widgetRef.current = widgetId;
      // Focus propagation (ROADMAP 7.2 cursors): report the change IMMEDIATELY
      // — the 10s TTL heartbeat is too slow for a live cursor badge; peers
      // see the focus move within one POST.
      if (changed && dashboardId && peerIdRef.current) {
        fetch(`/api/dashboards/${dashboardId}/presence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ peerId: peerIdRef.current, widgetId }),
          keepalive: true,
        }).catch(() => undefined);
      }
    },
    [dashboardId],
  );

  // Peers other than me — the avatar bar shows who ELSE is here.
  const others = peers.filter((p) => p.id !== peerIdRef.current);

  return { connected, peers: others, setWidget };
}
