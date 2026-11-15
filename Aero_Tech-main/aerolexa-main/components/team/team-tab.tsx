"use client";

import { ShieldCheck, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { DemoBadge, ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Dialog, useToast } from "@/components/ui/overlays";
import { Avatar } from "@/components/ui/primitives";
import { Badge, Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import type { ProjectRole, TeamMemberView } from "@/lib/types";

const ROLE_DESCRIPTION: Record<ProjectRole, string> = {
  OWNER: "Full control, including team management",
  EDITOR: "Can create and edit artifacts in this project",
  VIEWER: "Read-only access; can comment",
  AUDITOR: "Read-only access, including the audit trail",
};

export function TeamTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [members, setMembers] = useState<TeamMemberView[] | null>(null);
  const [myRole, setMyRole] = useState<ProjectRole>("VIEWER");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("EDITOR");
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ members: TeamMemberView[]; myRole: ProjectRole }>(`/api/projects/${projectId}/members`);
      setMembers(data.members);
      setMyRole(data.myRole);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = myRole === "OWNER";

  const addMember = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await api(`/api/projects/${projectId}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
      toast({ title: "Team member added", type: "success" });
      setAdding(false);
      setEmail("");
      await load();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (userId: string, next: ProjectRole) => {
    try {
      await api(`/api/projects/${projectId}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: next }),
      });
      toast({ title: "Role updated", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not update role", message: errorMessage(err), type: "error" });
    }
  };

  const remove = async (m: TeamMemberView) => {
    const ok = await confirm({
      title: `Remove ${m.name}${m.email ? ` (${m.email})` : ""} from this project?`,
      message: "They will lose access to this project and its notebooks, insights and reports.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${projectId}/members/${m.userId}`, { method: "DELETE" });
      toast({ title: "Member removed", type: "success" });
      await load();
    } catch (err) {
      toast({ title: "Could not remove member", message: errorMessage(err), type: "error" });
    }
  };

  if (!members) return <LoadingSkeleton rows={2} />;

  return (
    <div>
      {error && (
        <ErrorMessage title="Could not load the team" message={error} onRetry={() => void load()} className="mb-4" />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => setAdding(true)}
          disabled={!isOwner}
          title={isOwner ? undefined : "Only the project owner can add team members"}
          icon={<UserPlus aria-hidden className="size-4" />}
        >
          Add team member
        </Button>
        <div className="flex-1" />
        <DemoBadge tooltip="Shared projects: roles are enforced server-side; real-time presence/cursors are marked Prototype when enabled." />
      </div>

      {members.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title="Solo project"
            description="Add collaborators by email — they get EDITOR or VIEWER access with server-enforced roles."
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {members.map((m) => (
            <li key={m.userId}>
              <Card className="flex flex-wrap items-center gap-3 p-4">
                <Avatar name={m.name} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {m.name}
                    {m.userId === myRole && m.isOwner ? null : null}
                    {m.isOwner && (
                      <Badge variant="accent" className="gap-1">
                        <ShieldCheck aria-hidden className="size-3" /> Owner
                      </Badge>
                    )}
                    {!m.isOwner && m.addedAt && (
                      <span className="text-caption font-normal text-muted">joined {timeAgo(m.addedAt)}</span>
                    )}
                  </p>
                  {m.email && <p className="truncate text-caption text-muted">{m.email}</p>}
                  <p className="mt-0.5 text-caption text-muted">{ROLE_DESCRIPTION[m.role]}</p>
                </div>
                {m.isOwner ? (
                  <Badge variant="outline">{m.role.toLowerCase()}</Badge>
                ) : isOwner ? (
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>
                      Role for {m.name}
                    </label>
                    <select
                      id={`role-${m.userId}`}
                      value={m.role}
                      onChange={(e) => void changeRole(m.userId, e.target.value as ProjectRole)}
                      className="h-8 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                    >
                      <option value="EDITOR">Editor</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                    <Button variant="ghost" size="sm" aria-label={`Remove ${m.name}`} onClick={() => void remove(m)}>
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Badge variant={m.role === "EDITOR" ? "info" : "outline"}>{m.role.toLowerCase()}</Badge>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a team member"
        description="Invite an existing Ledgerly account by email. Roles are enforced server-side on every project surface."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={() => void addMember()} loading={busy} icon={<UserPlus aria-hidden className="size-4" />}>
              Add member
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <ErrorMessage title="Could not add member" message={formError} />}
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            >
              <option value="EDITOR">Editor — can create & edit analyses, dashboards, reports</option>
              <option value="VIEWER">Viewer — read-only, can comment</option>
            </select>
          </label>
          <p className="text-caption text-muted">
            Note: Ledgerly models one account per workspace; sharing a project grants explicit, audited access across
            workspaces.
          </p>
        </div>
      </Dialog>
    </div>
  );
}
