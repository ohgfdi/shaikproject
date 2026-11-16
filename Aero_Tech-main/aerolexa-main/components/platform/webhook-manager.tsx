"use client";

import { useState, useEffect } from "react";

/**
 * WebhookManager — manages webhook subscriptions for dashboard events.
 *
 * Allows users to subscribe to dashboard events such as:
 *   - widget:click
 *   - widget:filter-change
 *   - dashboard:saved
 *   - dashboard:export
 *
 * Webhook URLs are stored per-dashboard and can be edited/removed by owners.
 * The component communicates with `/api/webhooks` endpoints.
 *
 * Events sent to webhooks include the dashboard ID, widget ID, event type,
 * and a payload with relevant context (selected values, filter state, etc.).
 *
 * This component is typically used by power users / admins who want to
 * integrate dashboard actions with external systems (Slack, PagerDuty, CRMs, etc.).
 */
export interface WebhookSubscription {
  /** Unique identifier for the subscription. */
  id: string;
  /** The webhook URL to receive POST requests. */
  url: string;
  /** Which events this webhook is subscribed to. */
  events: ("widget:click" | "widget:filter-change" | "dashboard:saved" | "dashboard:export")[];
  /** When the subscription was created. */
  createdAt: string;
  /** Optional label for the subscription (e.g., "Slack alerts"). */
  label?: string;
  /** Optional secret for signature verification. */
  secret?: string;
}

/** Payload sent to webhooks for dashboard events. */
export interface WebhookPayload {
  /** The dashboard ID the event originated from. */
  dashboardId: string;
  /** The widget ID (if applicable). */
  widgetId?: string;
  /** The event type. */
  event: "widget:click" | "widget:filter-change" | "dashboard:saved" | "dashboard:export";
  /** Timestamp of the event. */
  timestamp: string;
  /** Event-specific data. */
  data: Record<string, unknown>;
}

/** Manage webhook subscriptions for a dashboard. */
export function WebhookManager({ dashboardId }: { dashboardId: string }) {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSubscriptions();
  }, [dashboardId]);

  const fetchSubscriptions = async () => {
    try {
      const res = await fetch(`/api/webhooks?dashboardId=${dashboardId}`);
      if (!res.ok) throw new Error("Failed to fetch webhooks");
      const data = await res.json();
      setSubscriptions(data.subscriptions ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addSubscription = async (url: string, events: WebhookSubscription["events"]) => {
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId, url, events }),
      });
      if (!res.ok) throw new Error("Failed to add webhook");
      fetchSubscriptions();
      setNewUrl("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeSubscription = async (id: string) => {
    try {
      await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      fetchSubscriptions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const updateSubscription = async (id: string, url: string, events: WebhookSubscription["events"]) => {
    try {
      await fetch(`/api/webhooks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events }),
      });
      fetchSubscriptions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Error state */}
      {error && (
        <div className="rounded border-red-500 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Add new webhook form */}
      {editingId === null ? (
        <div className="border rounded p-3 mb-4">
          <h3 className="font-medium mb-2">Add webhook</h3>
          <div className="space-y-2">
            <label className="block text-sm text-muted mb-1">
              URL
              <span className="text-caption text-muted ml-1">(must use HTTPS)</span>
            </label>
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/webhooks/ledgerly"
              className="w-full rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm text-muted mb-1">
              Subscribe to events
            </label>
            <div className="flex gap-2">
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={events.includes("widget:click")}
                  onChange={(e) => {
                    const newEvents = events;
                    if (e.target.checked) newEvents.add("widget:click");
                    else newEvents.delete("widget:click");
                    setEvents(newEvents);
                  }}
                />
                Widget click
              </label>
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={events.includes("widget:filter-change")}
                  onChange={(e) => {
                    const newEvents = events;
                    if (e.target.checked) newEvents.add("widget:filter-change");
                    else newEvents.delete("widget:filter-change");
                    setEvents(newEvents);
                  }}
                />
                Filter change
              </label>
            </div>
            <div className="flex items-center gap-2">
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={events.includes("dashboard:saved")}
                  onChange={(e) => {
                    const newEvents = events;
                    if (e.target.checked) newEvents.add("dashboard:saved");
                    else newEvents.delete("dashboard:saved");
                    setEvents(newEvents);
                  }}
                />
                Dashboard saved
              </label>
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={events.includes("dashboard:export")}
                  onChange={(e) => {
                    const newEvents = events;
                    if (e.target.checked) newEvents.add("dashboard:export");
                    else newEvents.delete("dashboard:export");
                    setEvents(newEvents);
                  }}
                />
                Dashboard export
              </label>
            </div>
          </div>
          <button
            onClick={() => addSubscription(newUrl, events)}
            className="mt-3 rounded border px-4 py-2 text-caption hover:bg-surface-2 transition-colors"
            disabled={!newUrl.trim()}
          >
            Subscribe
          </button>
        </div>
      ) : (
        /* Editing form */
        <div className="border rounded p-3 mb-4">
          <h3 className="font-medium mb-2">Edit webhook</h3>
          <p className="text-caption text-muted mb-2">
            URL: {subscriptions.find((s) => s.id === editingId)?.url ?? ""}
          </p>
          <div className="space-y-2">
            <input
              ref={(el) => {
                if (el) el.focus();
              }}
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/webhooks/ledgerly"
              className="w-full rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                const sub = subscriptions.find((s) => s.id === editingId);
                if (sub) {
                  updateSubscription(editingId, newUrl, sub.events);
                  setEditingId(null);
                  setNewUrl("");
                }
              }}
              className="rounded border px-3 py-1.5 text-caption hover:bg-surface-2 transition-colors flex-1"
            >
              Update
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="rounded border px-3 py-1.5 text-caption hover:text-red-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Existing subscriptions list */}
      <div>
        <h3 className="font-medium mb-2">Active webhooks</h3>
        {subscriptions.length === 0 && (
          <p className="text-caption text-muted">No webhooks subscribed.</p>
        )}

        <ul className="space-y-2 max-h-40 overflow-y-auto">
          {subscriptions.map((sub) => (
            <li key={sub.id} className="flex items-center gap-3 rounded border p-3">
              <span className="flex-1 truncate">{sub.url}</span>
              <div className="text-xs text-muted">
                {sub.events.join(", ")}
              </div>
              {sub.label && (
                <span className="ml-2 bg-surface-2 px-2 rounded text-caption">
                  {sub.label}
                </span>
              )}
              <button
                onClick={() => removeSubscription(sub.id)}
                className="ml-2 text-caption text-destructive hover:underline"
                aria-label={`Remove webhook ${sub.id}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}