"use client";

import { Ban, Check, Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";

/**
 * API-keys management (Settings → Security → API keys).
 *
 * The backend is complete — `POST/GET /api/auth/api-keys` issue and list keys,
 * `POST/DELETE /api/auth/api-keys/[keyId]` regenerate and revoke — but there
 * was no UI, so keys could not be created from the product. This panel
 * completes the loop:
 *
 *  - List: every key the user owns, with scopes, last-used, expiry, revoked.
 *  - Create: name + scopes + optional rate limit and expiry; the full secret
 *    is shown ONCE in a copyable field (the server stores a bcrypt hash only
 *    — losing the secret means regenerating).
 *  - Regenerate: revokes the old key and issues a replacement atomically.
 *  - Revoke: soft-delete; requests using the key fail immediately.
 *
 * Entitlements: free workspaces cannot create keys (the server rejects the
 * POST with a plan error — the form surfaces the exact message).
 */

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimit: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** The exact scope list the POST route validates against (no wildcard). */
const SCOPE_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "datasets:read", label: "datasets:read", description: "List datasets, read rows, run SQL" },
  { value: "datasets:write", label: "datasets:write", description: "Create datasets (upload/import)" },
  { value: "reports:read", label: "reports:read", description: "List and read reports" },
  { value: "reports:write", label: "reports:write", description: "Create and update reports" },
  { value: "execute:dax", label: "execute:dax", description: "Evaluate DAX measures over your datasets" },
  { value: "execute:sql", label: "execute:sql", description: "Run read-only SELECT queries" },
  { value: "notebooks:read", label: "notebooks:read", description: "Read notebooks and their outputs" },
  { value: "notebooks:write", label: "notebooks:write", description: "Create and update notebooks" },
  { value: "metrics:read", label: "metrics:read", description: "Read computed metrics and KPIs" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ApiKeysPanel() {
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["datasets:read", "reports:read"]);
  const [rateLimit, setRateLimit] = useState("60");
  const [expiresInDays, setExpiresInDays] = useState("");

  // One-time secret display
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ apiKeys: ApiKeyRow[] }>("/api/auth/api-keys?pageSize=100");
      setKeys(data.apiKeys);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setScopes(["datasets:read", "reports:read"]);
    setRateLimit("60");
    setExpiresInDays("");
    setFormError(null);
    setCreating(true);
  };

  const toggleScope = (value: string) =>
    setScopes((s) => (s.includes(value) ? s.filter((x) => x !== value) : [...s, value]));

  const create = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        scopes,
        rateLimit: Number(rateLimit) || 60,
      };
      const days = Number(expiresInDays);
      if (Number.isFinite(days) && days > 0) body.expiresInDays = days;
      const data = await api<{ key: string; warning: string }>("/api/auth/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setCreating(false);
      setCreatedKey(data.key);
      setCopied(false);
      await load();
      toast({ title: "API key created", message: data.warning, type: "success" });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: ApiKeyRow) => {
    const confirmed = await confirm({
      title: "Revoke API key?",
      message: `“${row.name}” (${row.keyPrefix}…) will stop working immediately. Scripts or integrations using it will start receiving 401 responses.`,
      confirmLabel: "Revoke key",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/auth/api-keys/${row.id}`, { method: "DELETE" });
      await load();
      toast({ title: "API key revoked", type: "success" });
    } catch (err) {
      toast({ title: "Could not revoke key", message: errorMessage(err), type: "error" });
    }
  };

  const regenerate = async (row: ApiKeyRow) => {
    const confirmed = await confirm({
      title: "Regenerate API key?",
      message: `A new secret will be issued for “${row.name}” and the current one stops working immediately. Save the new secret when it is shown.`,
      confirmLabel: "Regenerate",
    });
    if (!confirmed) return;
    try {
      const data = await api<{ key: string; warning: string }>(`/api/auth/api-keys/${row.id}`, { method: "POST" });
      setCreatedKey(data.key);
      setCopied(false);
      await load();
      toast({ title: "API key regenerated", message: data.warning, type: "success" });
    } catch (err) {
      toast({ title: "Could not regenerate key", message: errorMessage(err), type: "error" });
    }
  };

  const copyKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", message: "Select the key text and copy it manually.", type: "error" });
    }
  };

  if (error && keys === null) {
    return <ErrorMessage title="Could not load API keys" message={error} />;
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">API keys</p>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Programmatic access to the public API — list datasets, run SQL or DAX, read reports. Keys are stored
              hashed (bcrypt) and the full secret is shown only once at creation. Scope every key narrowly and revoke
              immediately when a credential leaks.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus aria-hidden className="size-4" />
            New API key
          </Button>
        </div>

        {error && keys !== null && <ErrorMessage title="Could not refresh API keys" message={error} />}

        {keys === null ? (
          <LoadingSkeleton rows={3} />
        ) : keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create a key to call the public API from scripts, CI jobs or integrations. Every request is rate-limited per key and audit-logged."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-caption text-muted">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Key</th>
                  <th className="py-2 pr-4 font-medium">Scopes</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Expires</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => {
                  const revoked = row.revokedAt !== null;
                  const expired = row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now();
                  return (
                    <tr key={row.id} className="border-b border-line/60 last:border-b-0">
                      <td className="py-2 pr-4 font-medium text-foreground">{row.name}</td>
                      <td className="py-2 pr-4 font-mono text-caption text-muted">{row.keyPrefix}…</td>
                      <td className="py-2 pr-4">
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {row.scopes.map((s) => (
                            <Badge key={s} variant="outline">
                              {s}
                            </Badge>
                          ))}
                        </div>
                        <span className="mt-1 block text-caption text-muted">{row.rateLimit}/min rate limit</span>
                      </td>
                      <td className="py-2 pr-4 text-muted">
                        {row.lastUsedAt ? <span title={row.lastUsedAt}>{timeAgo(row.lastUsedAt)}</span> : "never"}
                      </td>
                      <td className="py-2 pr-4 text-muted">{formatDate(row.expiresAt)}</td>
                      <td className="py-2 pr-4">
                        {revoked ? (
                          <Badge variant="critical">revoked</Badge>
                        ) : expired ? (
                          <Badge variant="warning">expired</Badge>
                        ) : (
                          <Badge variant="success">active</Badge>
                        )}
                      </td>
                      <td className="py-2">
                        {!revoked && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void regenerate(row)}
                              title="Issue a new secret for this key"
                            >
                              <RefreshCw aria-hidden className="size-4" />
                              <span className="sr-only">Regenerate {row.name}</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void revoke(row)}
                              title="Revoke immediately"
                            >
                              <Ban aria-hidden className="size-4" />
                              <span className="sr-only">Revoke {row.name}</span>
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* Create dialog */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New API key"
        description="Scope the key to the minimum permissions it needs. The secret is shown once after creation."
      >
        <div className="flex flex-col gap-4">
          {formError && <ErrorMessage title="Could not create key" message={formError} />}
          <Field label="Name" helper="What is this key for? (e.g. “CI pipeline”, “Zapier”)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="CI pipeline" />
          </Field>

          <fieldset>
            <legend className="text-sm font-medium text-foreground">Scopes</legend>
            <p className="mt-0.5 text-caption text-muted">
              Grant at least one. Keys can never escalate beyond this list.
            </p>
            <div className="mt-2 grid gap-1.5">
              {SCOPE_OPTIONS.map((s) => (
                <Checkbox
                  key={s.value}
                  label={s.label}
                  description={s.description}
                  checked={scopes.includes(s.value)}
                  onChange={() => toggleScope(s.value)}
                />
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rate limit (requests/min)" helper="1–1000. Requests over the limit get 429s.">
              <Input
                type="number"
                min={1}
                max={1000}
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
              />
            </Field>
            <Field label="Expires in (days, optional)" helper="Blank = never expires.">
              <Input
                type="number"
                min={1}
                max={3650}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="90"
              />
            </Field>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void create()} loading={busy} disabled={!name.trim() || scopes.length === 0}>
              Create key
            </Button>
          </div>
        </div>
      </Dialog>

      {/* One-time secret display */}
      <Dialog
        open={createdKey !== null}
        onClose={() => setCreatedKey(null)}
        title="Save your API key now"
        description="This secret will not be shown again. Store it in your password manager or CI secrets."
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-foreground">
              {createdKey}
            </code>
            <Button variant="secondary" onClick={() => void copyKey()}>
              {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-caption text-muted">
            Treat it like a password: anyone holding it can read your workspace data within its scopes. Rotate it from
            the keys table if it ever leaks.
          </p>
          <div className="flex justify-end">
            <Button onClick={() => setCreatedKey(null)}>I’ve saved it</Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
