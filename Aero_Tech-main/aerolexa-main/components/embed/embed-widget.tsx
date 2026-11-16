"use client";

import { useState, useEffect, useRef } from "react";

/**
 * EmbedWidget — renders a read-only dashboard map embedded in external pages.
 *
 * The embedded dashboard receives a JWT token via `data-token` and an optional
 * workspace ID via `data-workspace-id`. The token grants read-only access to
 * the dashboard configured for the workspace. The embed page isolates the
 * Leaflet map and does not expose any edit controls or webhook configuration.
 *
 * Props are passed as HTML data attributes so the component can be used without
 * a build step:
 *   <embed-widget
 *     data-token="eyJhbGciOiJ... "
 *     data-workspace-id="w_123"
 *     data-width="100%"
 *     data-height="600"
 *   />
 *
 * Communication with the parent page:
 *   - `message` events carry `{ type: "error", error }` or `{ type: "ready" }`
 *   - The embed height can be adjusted by the parent via `parent.postMessage`.
 */
export function EmbedWidget(): JSX.Element {
  const [ready, setReady] = useState(false);
  const token = useRef<string | null>(null);
  const workspaceId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read token and workspace from data attributes
  useEffect(() => {
    const el = document.querySelector("embed-widget") as HTMLMetaElement;
    if (!el) return;

    token.current = el.getAttribute("data-token") ?? null;
    workspaceId.current = el.getAttribute("data-workspace-id") ?? null;

    // Validate token with the API
    async function validate() {
      if (!token.current) {
        setError("No authentication token provided.");
        return;
      }

      try {
        const res = await fetch(
          `/api/embed/validate?token=${token.current}&workspaceId=${workspaceId.current ?? ""}`,
          { credentials: "include" }
        );
        if (!res.ok) {
          const txt = await res.text();
          setError(`Embed validation failed: ${txt}`);
          return;
        }
        setReady(true);
      } catch (e) {
        setError(`Embed validation error: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }

    validate();

    // Listen for messages from the embedded iframe (future use)
    window.addEventListener("message", (e) => {
      if (e.data?.type === "embed-height") {
        const docEl = document.querySelector("embed-widget") as HTMLElement;
        if (docEl) {
          docEl.style.height = `${e.data.height}px`;
        }
      }
    });
  }, []);

  if (!ready) {
    return (
      <div
        role="region"
        aria-label="Dashboard embed loading…"
        className="flex min-h-[300px] items-center justify-center rounded-border border-line p-4 text-caption text-muted"
        data-token={token.current ?? ""}
        data-workspace-id={workspaceId.current ?? ""}
      >
        Dashboard embed loading…
      </div>
    );
  }

  // Render the actual dashboard (read-only, simplified)
  return (
    <div
      role="region"
      aria-label={`Dashboard — ${workspaceId.current || "unknown"} workspace`}
      className="rounded-border bg-surface-1 overflow-hidden"
      style={{
        height: ready ? "600px" : "300px",
        width: "100%",
      }}
      data-token={token.current ?? ""}
      data-workspace-id={workspaceId.current ?? ""}
    >
      <div
        className="p-4"
        style={{ height: "100%", display: "flex", flexDirection: "column" }}
      >
        <h3 className="text-caption text-foreground mb-3">
          {workspaceId.current ? `Workspace ${workspaceId.current}` : "Dashboard"}
        </h3>
        <p className="text-caption text-muted/70">
          Read‑only view. To enable editing, sign in to the Ledgerly app.
        </p>
        {/* Placeholder for the map — in production this would render the
           full ChoroplethMap component with read-only props */}

        <div
          className="flex-1 rounded-border bg-surface-2 overflow-hidden"
          style={{ height: "400px", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <p className="text-caption text-muted/60">
            Map visualization (read‑only)
          </p>
        </div>
      </div>
    </div>
  );
}