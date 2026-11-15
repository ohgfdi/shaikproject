"use client";

import {
  AlertTriangle,
  BellRing,
  CheckCheck,
  FlaskConical,
  LayoutDashboard,
  PencilRuler,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/feedback";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  message: string | null;
  readAt: string | null;
  createdAt: string;
}

const TYPE_STYLE: Record<string, { icon: typeof BellRing; bg: string; color: string }> = {
  anomaly: { icon: AlertTriangle, bg: "rgba(255,180,0,0.16)", color: "#FFB400" },
  "data-quality": { icon: ShieldAlert, bg: "rgba(240,138,93,0.16)", color: "#F08A5D" },
  analysis: { icon: FlaskConical, bg: "rgba(124,92,255,0.16)", color: "#7C5CFF" },
  report: { icon: PencilRuler, bg: "rgba(61,155,233,0.16)", color: "#3D9BE9" },
  dashboard: { icon: LayoutDashboard, bg: "rgba(88,179,104,0.16)", color: "#58B368" },
  system: { icon: BellRing, bg: "rgba(90,168,170,0.16)", color: "#5AA8AA" },
};

const FALLBACK = { icon: BellRing, bg: "rgba(90,168,170,0.16)", color: "#5AA8AA" };

export function NotificationsPanel({ initial }: { initial: NotificationRow[] }) {
  const router = useRouter();
  const { confirm } = useConfirm();
  const [items, setItems] = useState<NotificationRow[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = items.filter((n) => !n.readAt).length;

  const markRead = async (ids: string[], all = false) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/notifications/read", {
        method: "POST",
        body: JSON.stringify(all ? { all: true } : { ids }),
      });
      setItems((prev) => prev.map((n) => (ids.includes(n.id) || all ? { ...n, readAt: new Date().toISOString() } : n)));
      router.refresh(); // keep the header unread badge in sync
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: "Clear all notifications?",
      message: `All ${items.length} notifications will be removed. This cannot be undone.`,
      confirmLabel: "Clear all",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/notifications", { method: "DELETE" });
      setItems([]);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={BellRing}
          title="You're all caught up"
          description="Notifications for anomalies, data-quality findings, completed analyses, reports and dashboard activity will land here."
        />
      </Card>
    );
  }

  return (
    <div>
      {error && <ErrorMessage title="Action failed" message={error} className="mb-3" />}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" role="status">
          {unread} unread · {items.length} total
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => markRead([], true)}
            loading={busy}
            disabled={unread === 0}
            icon={<CheckCheck aria-hidden className="size-4" />}
          >
            Mark all as read
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={clearAll}
            loading={busy}
            icon={<Trash2 aria-hidden className="size-4" />}
          >
            Clear all
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((n) => {
          const style = TYPE_STYLE[n.type] ?? FALLBACK;
          const Icon = style.icon;
          const unreadRow = !n.readAt;
          return (
            <li key={n.id}>
              <button
                onClick={() => !n.readAt && markRead([n.id])}
                aria-label={n.readAt ? n.title : `Mark “${n.title}” as read`}
                className={cn(
                  "card flex w-full items-start gap-3 px-4 py-3 text-left transition-shadow",
                  unreadRow ? "border-accent/30" : "opacity-75",
                )}
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: style.bg, color: style.color }}
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-sm font-medium text-foreground", !unreadRow && "font-normal")}>
                      {n.title}
                    </span>
                    {unreadRow && (
                      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: style.color }} />
                    )}
                  </span>
                  {n.message && <span className="block text-caption text-muted">{n.message}</span>}
                  <span className="mt-0.5 block text-caption text-muted/70">{timeAgo(new Date(n.createdAt))}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
