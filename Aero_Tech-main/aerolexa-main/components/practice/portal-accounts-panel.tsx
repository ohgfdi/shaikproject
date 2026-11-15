"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { PortalAccountView } from "@/lib/server/portal-auth";

/**
 * Firm-side client sign-ins. Inviting an email lets that person approve filings
 * as themselves instead of as "whoever held the link". The account is scoped to
 * this engagement and can be revoked without touching the read-only link.
 */
export function PortalAccountsPanel({ engagementId }: { engagementId: string }) {
  const [accounts, setAccounts] = useState<PortalAccountView[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ accounts: PortalAccountView[] }>(
        `/api/organization/engagements/${engagementId}/portal/accounts`,
      );
      setAccounts(data.accounts ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [engagementId]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = useCallback(async () => {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/api/organization/engagements/${engagementId}/portal/accounts`, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), name: name.trim() || null }),
      });
      setMessage(`Sign-in link sent to ${email.trim()}. It expires in 15 minutes.`);
      setEmail("");
      setName("");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [email, name, engagementId, load]);

  const revoke = useCallback(
    async (accountId: string) => {
      setBusy(true);
      setError(null);
      try {
        await api(
          `/api/organization/engagements/${engagementId}/portal/accounts?accountId=${encodeURIComponent(accountId)}`,
          { method: "DELETE" },
        );
        await load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [engagementId, load],
  );

  return (
    <Card className="mt-3">
      <CardContent className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Client sign-ins</h3>
          <p className="mt-1 text-caption text-muted">
            Invite the person who approves filings. A signed-in approval is recorded against their
            account; a link-only approval is recorded as link-based. Neither replaces a DSC.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 text-caption font-medium text-muted">
            Client email
            <Input
              type="email"
              className="mt-1"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="cfo@client.example"
              autoComplete="off"
            />
          </label>
          <label className="min-w-[10rem] flex-1 text-caption font-medium text-muted">
            Name (optional)
            <Input
              className="mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="R. Sharma"
              autoComplete="off"
            />
          </label>
          <Button type="button" size="sm" variant="secondary" disabled={busy || !email.trim()} onClick={() => void invite()}>
            Send sign-in link
          </Button>
        </div>

        {message && <p className="text-caption text-muted">{message}</p>}
        {error && <p className="text-caption text-danger">{error}</p>}

        {accounts.length > 0 && (
          <ul className="space-y-1 border-t border-line pt-2">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-foreground">{account.name ?? account.email}</span>
                  <span className="block text-caption text-muted">
                    {account.email}
                    {account.lastLoginAt
                      ? ` · last signed in ${new Date(account.lastLoginAt).toLocaleDateString("en-IN")}`
                      : " · never signed in"}
                  </span>
                  {account.lastInvite && (
                    <span
                      className={`block text-caption ${
                        account.lastInvite.status === "failed" ? "text-danger" : "text-muted"
                      }`}
                    >
                      {account.lastInvite.status === "sent"
                        ? `Invite delivered ${new Date(account.lastInvite.sentAt ?? account.createdAt).toLocaleString("en-IN")}`
                        : account.lastInvite.status === "failed"
                          ? `Invite failed: ${account.lastInvite.error ?? "unknown mail error"}`
                          : "Invite pending delivery"}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={account.revokedAt ? "warning" : "default"}>
                    {account.revokedAt ? "revoked" : "invited"}
                  </Badge>
                  {!account.revokedAt && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void revoke(account.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
