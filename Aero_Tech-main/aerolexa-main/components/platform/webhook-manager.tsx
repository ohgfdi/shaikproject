"use client";

import { useState, useEffect } from "react";

/**
 * WebhookManager — manages webhook subscriptions for dashboard events.
 *
 * Features:
 *   - Subscribe to dashboard events: widget:click, widget:filter-change,
 *     dashboard:saved, dashboard:export.
 *   - Each subscription has an idempotency key so retries don't duplicate events.
 *   - Automatic exponential-backoff retry on HTTP 5xx or network errors.
 *   - Subscription status (pending, active, failed, removed).
 *   - Edit/remove subscriptions.
 *
 * Webhook Payload format:
 *   { dashboardId, widgetId?, event, timestamp, data, idempotencyKey }
 *
 * Privacy: only the dashboard owner / power-user can manage webhooks.
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
  /** Idempotency key for retry protection. */
  idempotencyKey: string;
  /** Recent delivery status. */
  lastDelivery?: {
    status: "success" | "failed" | "pending";
    deliveredAt: string | null;
    error?: string;
  };
}

/** Payload sent to webhooks for dashboard events. */
export interface WebhookPayload {
  /** The dashboard ID the event originated from. */
  dashboardId: string;
  /** The widget ID (if applicable). */
  widgetId?: string;
  /** The event type. */
  event: "widget:click" | "widget:filter-change" | "dashboard:saved" | "dashboard:export";
  /** Timestamp of the event (ISO 8601). */
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
  const [retryId, setRetryId] = useState<string | null>(null);

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

  /** Submit a new webhook (with idempotency key). */
  const addSubscription = async (url: string, events: WebhookSubscription["events"]) => {
    const key = `${dashboardId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId, url, events, idempotencyKey: key }),
      });
      if (!res.ok) throw new Error("Failed to add webhook");
      fetchSubscriptions();
      setNewUrl("");
      setError(""); // clear any prior error
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Remove a subscription. */
  const removeSubscription = async (id: string) => {
    try {
      await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      fetchSubscriptions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Update a subscription. */
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

  /** Retry a failed delivery. */
  const retryDelivery = async (subscription: WebhookSubscription) => {
    setRetryId(subscription.id);
    try {
      const res = await fetch(`/api/webhooks/${subscription.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: subscription.idempotencyKey }),
      });
      if (!res.ok) throw new Error("Retry failed");
      // Refresh subscriptions to see updated status
      fetchSubscriptions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetryId(null);
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
            <label className="block text-sm text-muted mb-1">Subscribed events</label>
            <div className="flex gap-2">
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={subscriptions.some((s) => s.events.includes("widget:click"))}
                  onChange={(e) => {
                    const currentEvents = subscriptions.map((s) => s.events);
                    if (e.target.checked) {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: [...s.events, "widget:click"] } : prev
                        )
                      );
                    } else {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: s.events.filter((e) => e !== "widget:click") } : prev
                        )
                      );
                    }
                  }}
                />
                Widget click
              </label>
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={subscriptions.some((s) => s.events.includes("widget:filter-change"))}
                  onChange={(e) => {
                    const currentEvents = subscriptions.map((s) => s.events);
                    if (e.target.checked) {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: [...s.events, "widget:filter-change"] } : prev
                        )
                      );
                    } else {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: s.events.filter((e) => e !== "widget:filter-change") } : prev
                        )
                      );
                    }
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
                  checked={subscriptions.some((s) => s.events.includes("dashboard:saved"))}
                  onChange={(e) => {
                    const currentEvents = subscriptions.map((s) => s.events);
                    if (e.target.checked) {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: [...s.events, "dashboard:saved"] } : prev
                        )
                      );
                    } else {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: s.events.filter((e) => e !== "dashboard:saved") } : prev
                        )
                      );
                    }
                  }}
                />
                Dashboard saved
              </label>
              <label
                className="flex items-center gap-2 rounded border px-3 py-1.5 text-caption text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <input
                  type="checkbox"
                  checked={subscriptions.some((s) => s.events.includes("dashboard:export"))}
                  onChange={(e) => {
                    const currentEvents = subscriptions.map((s) => s.events);
                    if (e.target.checked) {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: [...s.events, "dashboard:export"] } : prev
                        )
                      );
                    } else {
                      setSubscriptions((prev) =>
                        prev.map((s) =>
                          s.id !== editingId ? { ...s, events: s.events.filter((e) => e !== "dashboard:export") } : prev
                        )
                      );
                    }
                  }}
                />
                Dashboard export
              </label>
            </div>
          </div>
          <button
            onClick={() => addSubscription(newUrl, subscriptions.map((s) => s.events).flat())
            }
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
              <div className="ml-2 flex items-center gap-1 text-caption text-muted">
                <span>Last delivery: {sub.lastDelivery?.deliveredAt ? new Date(sub.lastDelivery.deliveredAt).toLocaleString() : "never"}</span>
              </div>
              <button
                onClick={() => removeSubscription(sub.id)}
                className="ml-2 text-caption text-destructive hover:underline"
                aria-label={`Remove webhook ${sub.id}`}
              >
                Remove
              </button>
              {sub.lastDelivery?.status === "failed" && (
                <button
                  onClick={() => retryDelivery(sub)}
                  className="ml-2 text-caption text-primary hover:underline"
                  aria-label={`Retry delivery for webhook ${sub.id}`}
                >
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}