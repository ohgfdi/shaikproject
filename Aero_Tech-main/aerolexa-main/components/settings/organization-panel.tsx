"use client";

import { Building2, Layers, Plus, Shield, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Field, Input, Select, Checkbox } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { OrganizationRole } from "@/lib/types";

type OrganizationRoleKey = "OWNER" | "ADMIN" | "MEMBER" | "AUDITOR";

interface OrgSnapshot {
  id: string;
  name: string;
  gstin: string | null;
  role: OrganizationRoleKey | null;
  isOwner: boolean;
  memberCount: number;
  engagementCount: number;
  projectCount: number;
  createdAt: string;
}

interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRoleKey;
  isOwner: boolean;
  addedAt: string | null;
}

interface EngagementRow {
  id: string;
  name: string;
  code: string | null;
  gstin: string | null;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  description: string | null;
  projectCount: number;
  projectId: string | null;
  updatedAt: string;
  createdAt: string;
}

const ROLE_LABELS: Record<OrganizationRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  AUDITOR: "Auditor (read-only)",
};

const INVITABLE_ROLES: OrganizationRole[] = ["ADMIN", "MEMBER", "AUDITOR"];

const STATUS_BADGE: Record<EngagementRow["status"], "success" | "warning" | "outline"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  ARCHIVED: "outline",
};

function canAdmin(role: OrganizationRoleKey | null): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function OrganizationPanel() {
  const { toast } = useToast();
  const [org, setOrg] = useState<OrgSnapshot | null | undefined>(undefined);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ organization: OrgSnapshot | null }>("/api/organization");
      setOrg(data.organization);
      if (data.organization) {
        const [memberRes, engagementRes] = await Promise.all([
          api<{ members: OrgMember[] }>("/api/organization/members"),
          api<{ engagements: EngagementRow[] }>("/api/organization/engagements"),
        ]);
        setMembers(memberRes.members);
        setEngagements(engagementRes.engagements);
      }
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setOrg(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const notify = (title: string, message: string) => toast({ title, message, type: "success" });

  if (org === undefined) {
    return (
      <section aria-label="Organization">
        <h2 className="text-h2 text-foreground">Organization</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">Loading your firm account…</p>
      </section>
    );
  }

  if (!org) {
    return (
      <CreateOrganizationForm
        onCreated={async () => {
          await load();
          notify("Organization created", "Your firm account is ready.");
        }}
      />
    );
  }

  const admin = canAdmin(org.role);

  return (
    <section aria-label="Organization">
      {error && <ErrorMessage title="Could not load organization" message={error} />}
      <h2 className="text-h2 text-foreground">Organization</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        The firm identity that groups clients into confidential engagements. Your role:{" "}
        <span className="font-medium text-foreground">{ROLE_LABELS[org.role ?? "MEMBER"]}</span>.
      </p>

      <div className="mt-4 flex flex-col gap-4">
        {admin && <OrgIdentityCard org={org} onSaved={load} />}

        <Card>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Building2 aria-hidden className="size-4" />
              At a glance
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Stat label="Members" value={String(members.length || org.memberCount)} />
              <Stat label="Engagements" value={String(engagements.length || org.engagementCount)} />
              <Stat label="Client projects" value={String(org.projectCount)} />
              <Stat label="Firm since" value={org.createdAt.slice(0, 10)} />
            </div>
          </CardContent>
        </Card>

        {admin && <MembersCard members={members} onInvited={load} onChanged={load} onRemoved={load} />}
        {!admin && <ReadOnlyMembers members={members} />}

        {admin && <EngagementsCard engagements={engagements} onChanged={load} />}
        {!admin && <EngagementsList engagements={engagements} />}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2/60 px-3 py-2">
      <div className="text-h3 text-foreground">{value}</div>
      <div className="text-caption text-muted">{label}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Create firm                                                       */
/* ---------------------------------------------------------------- */

function CreateOrganizationForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [gstin, setGstin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/organization", {
        method: "POST",
        body: JSON.stringify({ name, gstin }),
      });
      await onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Create organization">
      <h2 className="text-h2 text-foreground">Organization</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Create a firm account to organize clients into confidential engagements. You become the firm owner and can
        invite teammates with Admin, Member, or read-only Auditor roles.
      </p>
      {error && (
        <div className="mt-3">
          <ErrorMessage title="Could not create organization" message={error} />
        </div>
      )}
      <Card className="mt-4">
        <CardContent className="flex flex-col gap-4">
          <Field label="Firm name" required helper="The name shown across the firm's workspaces.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme & Associates" />
          </Field>
          <Field label="GSTIN (optional)" helper="Used on billing and client reports.">
            <Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27AAABC1234A1Z5" />
          </Field>
          <div>
            <Button onClick={submit} loading={busy} icon={<Building2 aria-hidden className="size-4" />}>
              Create organization
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Firm identity                                                     */
/* ---------------------------------------------------------------- */

function OrgIdentityCard({ org, onSaved }: { org: OrgSnapshot; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(org.name);
  const [gstin, setGstin] = useState(org.gstin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/organization", {
        method: "PATCH",
        body: JSON.stringify({ name, gstin: gstin || null }),
      });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Building2 aria-hidden className="size-4" />
          Firm identity
        </div>
        {error && <ErrorMessage title="Could not save" message={error} />}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Firm name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="GSTIN">
            <Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27AAABC1234A1Z5" />
          </Field>
        </div>
        <div>
          <Button size="sm" onClick={save} loading={busy}>
            Save firm details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Members                                                           */
/* ---------------------------------------------------------------- */

function MembersCard({
  members,
  onInvited,
  onChanged,
  onRemoved,
}: {
  members: OrgMember[];
  onInvited: () => Promise<void>;
  onChanged: () => Promise<void>;
  onRemoved: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/organization/members", {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setEmail("");
      await onInvited();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const updateRole = async (userId: string, nextRole: OrganizationRole) => {
    try {
      await api(`/api/organization/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (userId: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the organization?`)) return;
    try {
      await api(`/api/organization/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
      await onRemoved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Users aria-hidden className="size-4" />
          Firm members
        </div>
        {error && <ErrorMessage title="Member change failed" message={error} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
          <Field label="Invite a teammate" helper="They need an existing account signed up to Ledgerly.">
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@firm.in"
              type="email"
            />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as OrganizationRole)}>
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button onClick={invite} loading={busy} icon={<Plus aria-hidden className="size-4" />}>
              Invite
            </Button>
          </div>
        </div>
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {m.name}
                  {m.isOwner && <span className="ml-2 text-caption text-muted">(firm owner)</span>}
                </div>
                <div className="text-caption text-muted">{m.email}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={m.isOwner ? "accent" : "default"}>{ROLE_LABELS[m.role]}</Badge>
                {!m.isOwner && (
                  <>
                    <Select
                      value={m.role}
                      aria-label={`Role for ${m.name}`}
                      onChange={(e) => void updateRole(m.userId, e.target.value as OrganizationRole)}
                      className="h-8 w-40"
                    >
                      {INVITABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => void remove(m.userId, m.name)}
                      icon={<Trash2 aria-hidden className="size-4" />}
                    />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReadOnlyMembers({ members }: { members: OrgMember[] }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Users aria-hidden className="size-4" />
          Firm members
        </div>
        <ul className="flex flex-col divide-y divide-line">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between py-2">
              <span className="text-sm text-foreground">{m.name}</span>
              <Badge variant={m.isOwner ? "accent" : "default"}>{ROLE_LABELS[m.role]}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Engagements                                                       */
/* ---------------------------------------------------------------- */

function EngagementsCard({ engagements, onChanged }: { engagements: EngagementRow[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [gstin, setGstin] = useState("");
  const [description, setDescription] = useState("");
  const [createProject, setCreateProject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/organization/engagements", {
        method: "POST",
        body: JSON.stringify({ name, code, gstin, description, createProject }),
      });
      setName("");
      setCode("");
      setGstin("");
      setDescription("");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (id: string, engagementName: string) => {
    if (
      !window.confirm(
        `Archive engagement “${engagementName}”? Projects stay visible but the engagement is marked archived.`,
      )
    )
      return;
    try {
      await api(`/api/organization/engagements/${encodeURIComponent(id)}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Layers aria-hidden className="size-4" />
          Client engagements
        </div>
        {error && <ErrorMessage title="Engagement change failed" message={error} />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Client / engagement name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Industries FY25" />
          </Field>
          <Field label="Engagement code (optional)" helper="Unique within the firm, e.g. ACME-FY25.">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ACME-FY25" />
          </Field>
          <Field label="GSTIN (optional)">
            <Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="27AAABC1234A1Z5" />
          </Field>
          <Field label="Description (optional)">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Annual statutory audit"
            />
          </Field>
        </div>
        <Checkbox
          label="Create a project for this engagement"
          description="A container for datasets, analyses and dashboards, visible to all firm members by role."
          checked={createProject}
          onChange={setCreateProject}
        />
        <div>
          <Button onClick={create} loading={busy} icon={<Plus aria-hidden className="size-4" />}>
            Create engagement
          </Button>
        </div>
        <EngagementsList engagements={engagements} onArchive={archive} />
      </CardContent>
    </Card>
  );
}

function EngagementsList({
  engagements,
  onArchive,
}: {
  engagements: EngagementRow[];
  onArchive?: (id: string, name: string) => void;
}) {
  if (engagements.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
        No engagements yet{onArchive ? " — create your first client silo above" : ""}.
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line border-t border-line">
      {engagements.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              {e.name}
              {e.code && <span className="text-caption text-muted">{e.code}</span>}
            </div>
            <div className="flex items-center gap-2 text-caption text-muted">
              <Badge variant={STATUS_BADGE[e.status]}>{e.status.toLowerCase()}</Badge>
              <span>
                {e.projectCount} project{e.projectCount === 1 ? "" : "s"}
              </span>
              {e.gstin && <span>GSTIN {e.gstin}</span>}
            </div>
          </div>
          {onArchive && e.status !== "ARCHIVED" && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onArchive(e.id, e.name)}
              icon={<Shield aria-hidden className="size-4" />}
            >
              Archive
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
