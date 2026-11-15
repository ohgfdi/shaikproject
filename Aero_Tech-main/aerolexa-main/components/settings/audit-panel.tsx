"use client";

import { KeyRound, ScrollText, ShieldCheck, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";

interface AuditEntry {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
  projectName: string | null;
  security: boolean;
}

function entryIcon(type: string): { icon: typeof ShieldCheck; className: string } {
  if (type.startsWith("MEMBER_")) return { icon: UserPlus, className: "bg-accent/12 text-accent" };
  if (type.startsWith("SECURITY_")) return { icon: KeyRound, className: "bg-warning/15 text-warning" };
  return { icon: ScrollText, className: "bg-surface-2 text-muted" };
}

export function AuditPanel() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"security" | "activity">("activity");

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ entries: AuditEntry[] }>(`/api/audit?scope=${scope}`);
      setEntries(data.entries);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-label="Audit log">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-h2 text-foreground">Audit log</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Immutable, read-only trail of account and workspace events — sign-ins/outs, team changes, scheduled runs and
            artifact activity. Never edited through the UI.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Audit scope" className="flex rounded-md border border-line bg-surface p-0.5">
            {(["activity", "security"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                aria-pressed={scope === s}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  scope === s ? "bg-accent/15 text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                {s === "security" ? "Security events" : "All activity"}
              </button>
            ))}
          </div>
          <a
            href={`/api/audit/export?scope=${scope}`}
            download
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
          >
            Export CSV
          </a>
        </div>
      </div>

      {error && (
        <ErrorMessage
          title="Could not load the audit log"
          message={error}
          onRetry={() => void load()}
          className="mt-4"
        />
      )}
      {!entries && !error && (
        <div className="mt-4">
          <LoadingSkeleton rows={1} />
        </div>
      )}

      {entries && entries.length === 0 && (
        <Card className="mt-4">
          <EmptyState
            icon={ScrollText}
            title="No events yet"
            description="Sign-in, team and scheduling events will appear here."
          />
        </Card>
      )}

      {entries && entries.length > 0 && (
        <Card className="mt-4">
          <ol className="thin-scroll max-h-[560px] divide-y divide-line overflow-y-auto">
            {entries.map((e) => {
              const meta = entryIcon(e.type);
              const Icon = meta.icon;
              return (
                <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${meta.className}`}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="text-foreground">{e.message}</p>
                    <p className="mt-0.5 text-caption text-muted">
                      {e.actorName ?? e.actorEmail ?? "system"} · {e.projectName ? `${e.projectName} · ` : ""}
                      {e.type.replace(/_/g, " ").toLowerCase()} · {timeAgo(e.createdAt)}
                    </p>
                  </div>
                  {e.security && (
                    <span aria-hidden className="mt-1 text-caption">
                      <ShieldCheck className="size-4 text-warning" />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
      <p className="mt-3 text-caption text-muted">
        Audit rows are append-only workspace records (Activity model). Export and filtering by actor/date are available
        through the API.
      </p>
    </section>
  );
}
