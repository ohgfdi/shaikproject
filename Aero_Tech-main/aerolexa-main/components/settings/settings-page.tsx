"use client";

import {
  BellRing,
  BookMarked,
  Bot,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Database,
  FileCheck2,
  KeyRound,
  Network,
  Palette,
  Plug,
  Save,
  Scale,
  ScrollText,
  ShieldCheck,
  User,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { AuditPanel } from "@/components/settings/audit-panel";
import { BillingPanel } from "@/components/settings/billing-panel";
import { ConnectorsPanel } from "@/components/settings/connectors-panel";
import { GovernancePanel } from "@/components/settings/governance-panel";
import { OrganizationPanel } from "@/components/settings/organization-panel";
import { PromptsPanel } from "@/components/settings/prompts-panel";
import { RlsPanel } from "@/components/settings/rls-panel";
import { ScheduledPanel, type ReportOption } from "@/components/settings/scheduled-panel";
import { Button } from "@/components/ui/button";
import { DemoBadge, ErrorMessage } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Card, CardContent, Badge } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { ACCENTS, type AccentName, type ThemeName } from "@/lib/theme";
import type { FeatureFlags, NumberFormatSetting, WorkspaceSettings } from "@/lib/types";
import {
  GOAL_OPTIONS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  NOTIFICATION_TYPE_SHORT,
  ROLE_OPTIONS,
  DATE_FORMAT_OPTIONS,
  TIMEZONE_OPTIONS,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export type SettingsTab =
  | "profile"
  | "workspace"
  | "organization"
  | "governance"
  | "billing"
  | "security"
  | "api-keys"
  | "notifications"
  | "appearance"
  | "data"
  | "ai"
  | "scheduled"
  | "prompts"
  | "sources"
  | "audit"
  | "report-templates"
  | "deliverables";

export interface SettingsUser {
  id: string;
  name: string;
  email: string;
  profileRole: string | null;
  organization: string | null;
  industry: string | null;
  experience: string | null;
  goals: string[];
  createdAt: string;
  emailVerified: boolean;
  /** Admin mode: full access to premium features and tools. */
  isAdmin: boolean;
}

export interface SettingsPageProps {
  initialTab: SettingsTab;
  user: SettingsUser;
  workspaceName: string;
  workspaceId: string;
  settings: WorkspaceSettings;
  theme: ThemeName;
  accent: AccentName;
  featureFlags: FeatureFlags;
  reports: ReportOption[];
}

const TABS: { key: SettingsTab; label: string; icon: typeof User; blurb: string }[] = [
  { key: "profile", label: "Profile", icon: User, blurb: "Name, role and background" },
  { key: "workspace", label: "Workspace", icon: Building2, blurb: "Workspace name and identity" },
  { key: "organization", label: "Organization", icon: Network, blurb: "Firm, members and engagements" },
  { key: "governance", label: "Governance", icon: Scale, blurb: "Access, change control, retention" },
  { key: "billing", label: "Billing", icon: CreditCard, blurb: "Plans, invoices and payment" },
  { key: "security", label: "Security", icon: ShieldCheck, blurb: "Password, sessions and SSO" },
  { key: "api-keys", label: "API keys", icon: KeyRound, blurb: "Programmatic access tokens" },
  { key: "notifications", label: "Notifications", icon: BellRing, blurb: "Choose what reaches the bell" },
  { key: "appearance", label: "Appearance", icon: Palette, blurb: "Theme and accent color" },
  { key: "data", label: "Data preferences", icon: Database, blurb: "Timezone and number formats" },
  { key: "ai", label: "AI preferences", icon: Bot, blurb: "Demo-mode behaviour" },
  { key: "scheduled", label: "Scheduled reports", icon: CalendarClock, blurb: "Automated report runs" },
  { key: "prompts", label: "Prompts", icon: BookMarked, blurb: "Reusable AI templates" },
  { key: "sources", label: "Data sources", icon: Plug, blurb: "External connectors" },
  { key: "audit", label: "Audit log", icon: ScrollText, blurb: "Read-only event trail" },
  { key: "report-templates", label: "Report templates", icon: FileCheck2, blurb: "Firm-wide master templates" },
  {
    key: "deliverables",
    label: "Deliverables",
    icon: ClipboardList,
    blurb: "Engagement deliverable formats & templates",
  },
];

export function SettingsPage({
  initialTab,
  user,
  workspaceName,
  workspaceId,
  settings,
  theme,
  accent,
  featureFlags,
  reports,
}: SettingsPageProps) {
  const validTab = TABS.some((t) => t.key === initialTab) ? initialTab : "profile";
  const [active, setActive] = useState<SettingsTab>(validTab);

  const tabButton = (key: SettingsTab, label: string, Icon: typeof User, blurb: string) => (
    <button
      key={key}
      onClick={() => setActive(key)}
      aria-pressed={active === key}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors",
        active === key
          ? "border-accent/60 bg-accent/10 text-foreground"
          : "border-line bg-surface text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>
        {label}
        <span className="block text-caption font-normal text-muted">{blurb}</span>
      </span>
    </button>
  );

  return (
    <div>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => tabButton(t.key, t.label, t.icon, t.blurb))}
      </nav>
      <div className="mt-5">
        <div hidden={active !== "profile"}>
          <ProfilePanel user={user} />
        </div>
        <div hidden={active !== "workspace"}>
          <WorkspacePanel name={workspaceName} id={workspaceId} />
        </div>
        <div hidden={active !== "organization"}>
          <OrganizationPanel />
        </div>
        <div hidden={active !== "governance"}>
          <GovernancePanel />
        </div>
        <div hidden={active !== "billing"}>
          <BillingPanel />
        </div>
        <div hidden={active !== "security"}>
          <SecurityPanel user={user} />
          <SsoStatusCard featureFlags={featureFlags} />
          <div className="mt-6">
            <RlsPanel />
          </div>
        </div>
        <div hidden={active !== "api-keys"}>
          <ApiKeysPanel />
        </div>
        <div hidden={active !== "notifications"}>
          <NotificationsPanel settings={settings} />
        </div>
        <div hidden={active !== "appearance"}>
          <AppearancePanel theme={theme} accent={accent} />
        </div>
        <div hidden={active !== "data"}>
          <DataPanel settings={settings} />
        </div>
        <div hidden={active !== "ai"}>
          <AiPanel settings={settings} />
        </div>
        <div hidden={active !== "scheduled"}>
          <ScheduledPanel reports={reports} schedulerEnabled={featureFlags.schedulerEnabled} />
        </div>
        <div hidden={active !== "prompts"}>
          <PromptsPanel />
        </div>
        <div hidden={active !== "sources"}>
          <ConnectorsPanel connectors={featureFlags.connectors} />
        </div>
        <div hidden={active !== "audit"}>
          <AuditPanel />
        </div>
        <div hidden={active !== "report-templates"}>
          <ReportTemplatesPanel />
        </div>
        <div hidden={active !== "deliverables"}>
          <DeliverablesPanel />
        </div>
      </div>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="text-h2 text-foreground">{title}</h2>
      {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/* Enterprise SSO status — JWT auth always works; SSO is env-configured. */
function SsoStatusCard({ featureFlags }: { featureFlags: FeatureFlags }) {
  const enabled = featureFlags.ssoEnabled && featureFlags.ssoProvider;
  const samlLive = featureFlags.samlEnabled;
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm font-medium text-foreground">Enterprise SSO</p>
        <p className="text-sm text-muted">
          {enabled
            ? `Single sign-on is configured (${featureFlags.ssoProvider}). ${
                featureFlags.ssoProvider === "SAML"
                  ? "The SAML flow is live end-to-end: /api/auth/saml/authorize starts the Web Browser SSO profile (HTTP-Redirect binding) and /api/auth/saml/acs validates the signed response against the IdP metadata before provisioning the account by verified email."
                  : "“Continue with Google” appears on the login screen; a workspace is provisioned on first sign-in and later sign-ins are linked by verified email."
              }`
            : `Single sign-on is not configured. Set SSO_ENABLED=true with GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET, or SAML_METADATA_URL (any SAML 2.0 IdP — Okta, Entra ID, OneLogin, Keycloak) to enable SSO. Email + password (JWT) auth keeps working either way.`}
        </p>
        <div className="flex items-center gap-2">
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? `${featureFlags.ssoProvider} configured` : "not configured"}
          </Badge>
          {samlLive && <Badge variant="success">SAML flow active</Badge>}
          {!enabled && (
            <DemoBadge
              compact
              tooltip="SSO credentials are environment variables only — no secrets in the client or database."
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

function ProfilePanel({ user }: { user: SettingsUser }) {
  const { toast } = useToast();
  const [name, setName] = useState(user.name);
  const [profileRole, setProfileRole] = useState<string>(user.profileRole ?? "");
  const [organization, setOrganization] = useState(user.organization ?? "");
  const [industry, setIndustry] = useState(user.industry ?? "");
  const [experience, setExperience] = useState(user.experience ?? "");
  const [goals, setGoals] = useState<string[]>(user.goals);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleGoal = (value: string) =>
    setGoals((g) => (g.includes(value) ? g.filter((x) => x !== value) : [...g, value]));

  // Admin mode. The toggle renders only for an existing admin: the API also
  // refuses `isAdmin` writes from non-admins, so this can never be used to
  // self-promote. Bootstrap the first admin through the database/seed.
  const [isAdmin, setIsAdmin] = useState<boolean>(user.isAdmin);
  const adminToggleVisible = user.isAdmin;
  const toggleAdmin = async (value: boolean) => {
    setIsAdmin(value);
    try {
      await api("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ isAdmin: value ? true : false }),
      });
      toast({ title: value ? "Admin privileges enabled" : "Admin privileges disabled", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
      setIsAdmin(!value); // revert on failure
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me", {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          profileRole: profileRole || null,
          organization: organization.trim() || null,
          industry: industry.trim() || null,
          experience: experience || null,
          goals,
          isAdmin,
        }),
      });
      toast({ title: "Profile saved", message: "Your profile has been updated.", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Profile"
      description="How Ledgerly addresses you and how you describe yourself. This shapes onboarding prompts and default report styling."
    >
      {error && <ErrorMessage title="Could not save" message={error} />}
      <Card>
        <CardContent className="p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Full name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </Field>
            <Field label="Email" helper="Used for sign-in and notifications. Contact support to change it.">
              <Input value={user.email} disabled />
            </Field>
            <Select
              label="Role"
              value={profileRole}
              onChange={(e) => setProfileRole(e.target.value)}
              placeholder="Select your role"
              options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
            />
            <Field label="Organization">
              <Input
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder="Acme Inc."
                autoComplete="organization"
              />
            </Field>
            <Field label="Industry">
              <Input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. Retail, SaaS, Healthcare"
              />
            </Field>
            <Select
              label="Experience level"
              value={experience}
              onChange={(e) => setExperience(e.target.value)}
              placeholder="Select experience"
              options={[
                { value: "Beginner", label: "Beginner" },
                { value: "Intermediate", label: "Intermediate" },
                { value: "Advanced", label: "Advanced" },
              ]}
            />
          </div>
          <div className="mt-5">
            <p className="text-sm font-medium text-foreground">What are you trying to accomplish?</p>
            <p className="mt-0.5 text-caption text-muted">Goals tune which starter templates Ledgerly suggests.</p>
            <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {GOAL_OPTIONS.map((g) => (
                <li key={g.value}>
                  <Checkbox
                    label={g.label}
                    checked={goals.includes(g.value)}
                    onChange={() => toggleGoal(g.value)}
                    className="rounded-md border border-line bg-surface px-2.5 py-2"
                  />
                </li>
              ))}
            </ul>
          </div>
          {adminToggleVisible && (
            <div className="mt-5 rounded-md border border-line bg-surface-2 p-3">
              <Checkbox
                label="Admin mode — unlock all premium features"
                description="Grants access to Notebooks, Scheduled Reports, the Prompt Library, LLM features, server-side rendering and every advanced engine, regardless of feature flags. Only existing admins can change this."
                checked={isAdmin}
                onChange={(v) => void toggleAdmin(v)}
              />
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <Button onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

function WorkspacePanel({ name, id }: { name: string; id: string }) {
  const { toast } = useToast();
  const [workspaceName, setWorkspaceName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/workspace", {
        method: "PATCH",
        body: JSON.stringify({ name: workspaceName.trim() }),
      });
      toast({ title: "Workspace updated", message: "The workspace name was changed.", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Workspace"
      description="Ledgerly keeps every project, dataset and artifact inside your workspace. In this prototype each account owns one personal workspace with workspace-level access control enforced on the server."
    >
      {error && <ErrorMessage title="Could not update" message={error} />}
      <Card>
        <CardContent className="p-5">
          <Field label="Workspace name" required helper="Shown in headers and exports.">
            <Input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
          </Field>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-caption text-muted">
              Workspace ID <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{id}</code>
            </p>
            <Button onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
              Save workspace
            </Button>
          </div>
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

function SecurityPanel({ user }: { user: SettingsUser }) {
  const { toast } = useToast();
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokePassword, setRevokePassword] = useState("");

  const changePassword = async () => {
    setError(null);
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      toast({ title: "Password changed", message: "Use the new password next time you sign in.", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Security"
      description="Keep your account protected. Passwords are hashed with bcrypt and session tokens are signed server-side — secrets never reach the browser."
    >
      {error && <ErrorMessage title="Could not change password" message={error} />}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-muted" />
            <h3 className="text-h3 text-foreground">Change password</h3>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Current password" required>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="New password" required helper="At least 8 characters.">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm new password" required>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={changePassword} loading={busy} icon={<Save aria-hidden className="size-4" />}>
              Update password
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h3 className="text-h3 text-foreground">Account status</h3>
          <ul className="mt-3 flex flex-col gap-2">
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">Email</span>
              <span className="font-medium text-foreground">{user.email}</span>
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">Email verified</span>
              {user.emailVerified ? (
                <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
                  <CheckCircle2 aria-hidden className="size-3.5" /> Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="border-amber/40 bg-amber/10 text-amber">
                  Pending verification
                </Badge>
              )}
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">Member since</span>
              <span className="font-medium text-foreground">{new Date(user.createdAt).toLocaleDateString()}</span>
            </li>
          </ul>

          {/* Real session revocation: bumps User.sessionVersion so every
              outstanding session JWT is rejected at the next request. */}
          <div className="mt-4 rounded-md border border-line bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="size-4 text-muted" />
              <h4 className="text-sm font-medium text-foreground">Sign out everywhere</h4>
            </div>
            <p className="mt-1 text-caption text-muted">
              Revokes every active session — including this one — by invalidating all issued tokens. You will be signed
              out on all devices immediately.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Confirm with current password">
                <Input
                  type="password"
                  value={revokePassword}
                  onChange={(e) => setRevokePassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-56"
                />
              </Field>
              <Button
                variant="secondary"
                loading={revokeBusy}
                onClick={async () => {
                  setRevokeBusy(true);
                  setError(null);
                  try {
                    const res = await api<{ revoked: boolean; message?: string }>("/api/me/sessions/revoke", {
                      method: "POST",
                      body: JSON.stringify({ currentPassword: revokePassword }),
                    });
                    if (!res.revoked) {
                      setError(res.message ?? "Could not revoke sessions.");
                      return;
                    }
                    toast({ title: "Signed out everywhere", message: "All sessions were revoked.", type: "success" });
                    router.push("/login");
                    router.refresh();
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setRevokeBusy(false);
                  }
                }}
              >
                Revoke all sessions
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <MfaCard />
    </Panel>
  );
}

interface MfaStatusResponse {
  enabled: boolean;
  setupPending: boolean;
  recoveryCodesRemaining: number;
}

/**
 * Two-factor enrolment (TOTP). The seed is shown once for the authenticator
 * app; recovery codes are shown once at enable time and stored only as hashes.
 * Disabling requires a current code, so a hijacked tab cannot remove MFA.
 */
function MfaCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<MfaStatusResponse>("/api/me/mfa"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startSetup = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api<{ secret: string; otpauthUrl: string }>("/api/me/mfa/setup", { method: "POST" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>("/api/me/mfa/enable", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      toast({ title: "Two-factor enabled", message: "Save your recovery codes now.", type: "success" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/mfa/disable", { method: "POST", body: JSON.stringify({ code }) });
      setCode("");
      toast({ title: "Two-factor disabled", message: "Sign-in now uses your password only.", type: "success" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden className="size-4 text-muted" />
          <h3 className="text-h3 text-foreground">Two-factor authentication</h3>
        </div>
        {error && (
          <div className="mt-3">
            <ErrorMessage title="Two-factor authentication" message={error} />
          </div>
        )}

        {recoveryCodes ? (
          <div className="mt-3 rounded-md border border-amber/40 bg-amber/10 p-3">
            <p className="text-sm font-medium text-foreground">
              Save these recovery codes somewhere safe. They are shown once.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-foreground">
              {recoveryCodes.map((recoveryCode) => (
                <span key={recoveryCode}>{recoveryCode}</span>
              ))}
            </div>
            <Button variant="secondary" className="mt-3" onClick={() => setRecoveryCodes(null)}>
              I have saved them
            </Button>
          </div>
        ) : status?.enabled ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Enabled. {status.recoveryCodesRemaining} recovery code
              {status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Current code">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="w-40"
                />
              </Field>
              <Button variant="secondary" loading={busy} onClick={disable}>
                Disable two-factor
              </Button>
            </div>
          </>
        ) : setup ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Add this key to your authenticator app, then enter the 6-digit code it shows.
            </p>
            <code className="mt-2 block break-all rounded-md border border-line bg-surface-2 p-2 font-mono text-sm text-foreground">
              {setup.secret}
            </code>
            <p className="mt-1 break-all text-caption text-muted">{setup.otpauthUrl}</p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="6-digit code">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="w-40"
                />
              </Field>
              <Button loading={busy} onClick={enable}>
                Enable two-factor
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted">
              Require a time-based code from your authenticator app in addition to your password. Recovery codes are
              issued once at setup.
            </p>
            <Button className="mt-3" loading={busy} onClick={startSetup}>
              Set up two-factor
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function NotificationsPanel({ settings }: { settings: WorkspaceSettings }) {
  const { toast } = useToast();
  const [types, setTypes] = useState<string[]>(
    settings.notificationTypes?.length ? settings.notificationTypes : [...NOTIFICATION_TYPES],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (t: string) => {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
    setTypes(next);
    setSaving(true);
    setError(null);
    try {
      await api("/api/workspace", {
        method: "PATCH",
        body: JSON.stringify({ settings: { notificationTypes: next } }),
      });
      toast({ title: "Preferences saved", message: "Notification delivery updated.", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
      // revert on failure so the UI reflects what the server accepted
      setTypes(settings.notificationTypes?.length ? settings.notificationTypes : [...NOTIFICATION_TYPES]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Notification preferences"
      description="Choose which events create alerts in your notification center. Silenced events still appear in project activity logs — only the bell is filtered."
    >
      {error && <ErrorMessage title="Could not save preferences" message={error} />}
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted">{saving ? "Saving…" : "In-app alerts"}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                setTypes([...NOTIFICATION_TYPES]);
                setSaving(true);
                setError(null);
                try {
                  await api("/api/workspace", {
                    method: "PATCH",
                    body: JSON.stringify({ settings: { notificationTypes: [...NOTIFICATION_TYPES] } }),
                  });
                  toast({
                    title: "All notifications enabled",
                    message: "Every category will reach your bell again.",
                    type: "success",
                  });
                } catch (err) {
                  setError(errorMessage(err));
                  setTypes(types);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Restore all
            </Button>
          </div>
          <ul className="flex flex-col gap-2">
            {NOTIFICATION_TYPES.map((t) => (
              <li key={t}>
                <Checkbox
                  label={NOTIFICATION_TYPE_LABELS[t]}
                  description={types.includes(t) ? "Enabled" : "Silenced"}
                  checked={types.includes(t)}
                  onChange={() => toggle(t)}
                  className="rounded-md border border-line bg-surface px-3 py-2.5"
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 flex items-center gap-1.5 text-caption text-muted">
            <BellRing aria-hidden className="size-3.5" />
            Type labels: {NOTIFICATION_TYPES.map((t) => NOTIFICATION_TYPE_SHORT[t]).join(" · ")}
          </p>
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

function AppearancePanel({ theme, accent }: { theme: ThemeName; accent: AccentName }) {
  const router = useRouter();
  const { toast } = useToast();
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(theme);
  const [currentAccent, setCurrentAccent] = useState<AccentName>(accent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (nextTheme: ThemeName, nextAccent: AccentName) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/appearance", {
        method: "POST",
        body: JSON.stringify({ theme: nextTheme, accent: nextAccent }),
      });
      setCurrentTheme(nextTheme);
      setCurrentAccent(nextAccent);
      router.refresh(); // root layout re-reads cookies and re-renders html classes
      toast({
        title: "Appearance updated",
        message: `${nextTheme === "dark" ? "Dark" : "Light"} theme with the ${nextAccent} accent.`,
        type: "success",
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Appearance"
      description="Ledgerly ships a WCAG-AA design system in dark and light mode with a 60/30/10 color ratio. Your choice is stored on this device."
    >
      {error && <ErrorMessage title="Could not update appearance" message={error} />}
      <Card>
        <CardContent className="p-5">
          <p className="text-sm font-medium text-foreground">Theme</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(["dark", "light"] as const).map((t) => (
              <button
                key={t}
                onClick={() => apply(t, currentAccent)}
                aria-pressed={currentTheme === t}
                className={cn(
                  "rounded-md border px-4 py-3 text-left transition-colors",
                  currentTheme === t ? "border-accent/60 bg-accent/10" : "border-line bg-surface hover:bg-surface-2",
                )}
              >
                <span className="block font-medium capitalize text-foreground">{t} mode</span>
                <span className="block text-caption text-muted">
                  {t === "dark" ? "Deep neutrals (#0A0A0A) — default" : "High-contrast light surfaces"}
                </span>
              </button>
            ))}
          </div>

          <p className="mt-6 text-sm font-medium text-foreground">Accent color</p>
          <p className="mt-0.5 text-caption text-muted">
            Used for primary actions, focus rings and highlights. Contrast is checked in both themes.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                onClick={() => apply(currentTheme, a.value)}
                aria-pressed={currentAccent === a.value}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  currentAccent === a.value
                    ? "border-accent/60 bg-accent/10 text-foreground"
                    : "border-line bg-surface text-muted hover:bg-surface-2",
                )}
              >
                <span
                  aria-hidden
                  // A hardcoded black hairline disappears on the dark surface;
                  // the token border keeps the swatch edge visible in both.
                  className="size-4 rounded-full border border-line"
                  style={{ backgroundColor: a.swatch }}
                />
                {a.label}
                {currentAccent === a.value && <CheckCircle2 aria-hidden className="size-4 text-accent" />}
              </button>
            ))}
          </div>
          {busy && <p className="mt-3 text-caption text-muted">Applying…</p>}
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Data preferences                                                    */
/* ------------------------------------------------------------------ */

function DataPanel({ settings }: { settings: WorkspaceSettings }) {
  const { toast } = useToast();
  const [timezone, setTimezone] = useState(settings.timezone ?? "UTC");
  const [numberFormat, setNumberFormat] = useState<NumberFormatSetting>(settings.numberFormat);
  const [dateFormat, setDateFormat] = useState(settings.dateFormat ?? "medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/workspace", {
        method: "PATCH",
        body: JSON.stringify({ settings: { timezone, numberFormat, dateFormat } }),
      });
      toast({
        title: "Data preferences saved",
        message: "Applied to new analyses, charts and exports.",
        type: "success",
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const examples: Record<NumberFormatSetting, string> = {
    comma: "1,234,567.89",
    dot: "1.234.567,89",
    plain: "1234567.89",
  };

  return (
    <Panel
      title="Data preferences"
      description="Defaults for how numbers, dates and times are displayed across charts, tables and exports. They never change your underlying data."
    >
      {error && <ErrorMessage title="Could not save preferences" message={error} />}
      <Card>
        <CardContent className="p-5">
          <Select
            label="Timezone"
            helper="Used for trend buckets and date grouping."
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            options={TIMEZONE_OPTIONS.map((t) => ({ value: t, label: t }))}
          />
          <div className="mt-5">
            <p className="text-sm font-medium text-foreground">Number format</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(["comma", "dot", "plain"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setNumberFormat(f)}
                  aria-pressed={numberFormat === f}
                  className={cn(
                    "rounded-md border px-3 py-2.5 text-left transition-colors",
                    numberFormat === f ? "border-accent/60 bg-accent/10" : "border-line bg-surface hover:bg-surface-2",
                  )}
                >
                  <span className="block text-sm font-medium capitalize text-foreground">{f}</span>
                  <span className="block text-caption tabular-nums text-muted">{examples[f]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-5">
            <Select
              label="Date format"
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              options={DATE_FORMAT_OPTIONS.map((d) => ({ value: d.value, label: d.label }))}
            />
          </div>
          <div className="mt-5 flex justify-end">
            <Button onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
              Save preferences
            </Button>
          </div>
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* AI preferences                                                      */
/* ------------------------------------------------------------------ */

function AiPanel({ settings }: { settings: WorkspaceSettings }) {
  const { toast } = useToast();
  const [demoMode, setDemoMode] = useState(settings.aiDemoMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setDemoMode(next);
    setBusy(true);
    setError(null);
    try {
      await api("/api/workspace", {
        method: "PATCH",
        body: JSON.stringify({ settings: { aiDemoMode: next } }),
      });
      toast({
        title: next ? "Demo mode enabled" : "Demo mode disabled",
        message: next
          ? "Prototype results are labelled with the demo badge."
          : "Prototype results will not be labelled. Your data is never sent to third-party AI services either way.",
        type: "success",
      });
    } catch (err) {
      setError(errorMessage(err));
      setDemoMode(settings.aiDemoMode);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="AI preferences"
      description="Ledgerly's current intelligence is deterministic, in-browser prototype logic — there is no hidden model. This page controls how that is surfaced."
    >
      {error && <ErrorMessage title="Could not save preference" message={error} />}
      <Card>
        <CardContent className="p-5">
          <Checkbox
            label="Show “Prototype / Demo” badges on prototype results"
            description="Every result computed with prototype logic carries a subtle badge and tooltip. Disabling the badge does not change the logic — it only hides the label. We recommend keeping it on."
            checked={demoMode}
            onChange={(v) => toggle(v)}
          />
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-h3 text-foreground">How results are labelled</h3>
            <p className="mt-2 text-caption text-muted">
              Every analysis in Ledgerly — EDA, KPI, distribution, correlation, trend, variance, segmentation, forecast,
              what-if (with cross-validated ridge rescue), cohort, notebook DSL, Business Advisor, ML training/serving
              (with Shapley explanations and conformal intervals) — is computed by deterministic in-repo engines and
              pinned by oracle tests (SciPy/NumPy/statsmodels comparisons or hand-computed fixtures) in CI. The only
              badges you will see mark demonstration data or genuinely unavailable services, never unvalidated math.
            </p>
            <p className="mt-2 text-caption text-muted">
              Advanced engines shipped and oracle-tested include: uplift modeling (Qini evaluation), synthetic control
              (Abadie), ARIMAX dynamic regression with hierarchical reconciliation, A/B serving (Wald SPRT +
              guardrails), and a two-stage retrieval reranker. Results computed by these engines cite their methodology
              in the UI — every number is reproducible from the cited formula and inputs.
            </p>
            {busy && <p className="mt-2 text-caption text-muted">Saving…</p>}
          </div>
        </CardContent>
      </Card>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Report Templates (firm-wide master templates)                      */
/* ------------------------------------------------------------------ */

function ReportTemplatesPanel() {
  const { toast } = useToast();
  const [masters, setMasters] = useState<
    Array<{
      id: string;
      formatCode: string;
      label: string;
      body: string;
      firmName: string;
      createdAt: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    formatCode: "BALANCE_SHEET",
    label: "",
    body: JSON.stringify({ parts: [], precedents: [], cover: null }, null, 2),
    firmName: "",
  });
  const [createBusy, setCreateBusy] = useState(false);

  const fetchMasters = async () => {
    try {
      const res = await api<
        Array<{
          id: string;
          formatCode: string;
          label: string;
          body: string;
          firmName: string;
          createdAt: string;
        }>
      >("/api/organization/settings/report-templates");
      setMasters(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setCreateBusy(true);
    setError(null);
    try {
      await api("/api/organization/settings/report-templates", {
        method: "POST",
        body: JSON.stringify({
          formatCode: form.formatCode,
          label: form.label,
          body: form.body,
          firmName: form.firmName,
        }),
      });
      toast({ title: "Master template created", message: "Available for all engagements.", type: "success" });
      setShowCreate(false);
      setForm({
        formatCode: "BALANCE_SHEET",
        label: "",
        body: JSON.stringify({ parts: [], precedents: [], cover: null }, null, 2),
        firmName: "",
      });
      fetchMasters();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this master template? Engagements that derived from it will keep their copy.")) return;
    try {
      await api(`/api/organization/settings/report-templates?id=${id}`, { method: "DELETE" });
      toast({ title: "Deleted", message: "Master template removed.", type: "success" });
      fetchMasters();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    fetchMasters();
  }, []);

  return (
    <Panel
      title="Firm-wide report templates"
      description="Master templates define the structure and default content for each deliverable format. Engagements can derive their own templates from these masters."
    >
      {error && <ErrorMessage title="Could not load templates" message={error} />}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-h3 text-foreground">Master templates</h3>
        <Button onClick={() => setShowCreate(true)} icon={<FileCheck2 aria-hidden className="size-4" />}>
          Create master
        </Button>
      </div>
      {showCreate && (
        <Card className="mb-4">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-h3 text-foreground">New master template</h4>
              <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
            <Select
              label="Format code"
              value={form.formatCode}
              onChange={(e) => setForm({ ...form, formatCode: e.target.value })}
              options={[
                "FINANCIALS",
                "PROFIT_LOSS",
                "BALANCE_SHEET",
                "NOTES",
                "SCHEDULES",
                "MGMT_LETTER",
                "TAX_COMPUTATION",
                "CERTIFICATE_44AB",
                "CERTIFICATE_44ADA",
                "CERTIFICATE_44AD",
                "TAX_CONCLUSION",
                "AUDIT_FINDINGS",
                "MANAGING_AGENT_LETTER",
                "LETTER_TO_CLIENT",
              ].map((c) => ({ value: c, label: c }))}
            />
            <Field label="Label" required>
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. FY26 Balance Sheet"
              />
            </Field>
            <Field label="Firm name" helper="Used as default ^^FIRM_NAME^^ placeholder">
              <Input value={form.firmName} onChange={(e) => setForm({ ...form, firmName: e.target.value })} />
            </Field>
            <Field
              label="Template body (JSON)"
              helper="Engine format: { cover, parts[], precedents[] }. Use ^^PLACEHOLDER^^ tokens."
            >
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                className="font-mono text-xs w-full rounded-md border border-line bg-surface px-3 py-2 min-h-[200px] resize-y"
                spellCheck={false}
              />
            </Field>
            <div className="flex justify-end">
              <Button onClick={handleCreate} loading={createBusy} icon={<Save aria-hidden className="size-4" />}>
                Create master
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : masters.length === 0 ? (
        <p className="text-muted">No master templates yet. Create one to start.</p>
      ) : (
        <div className="space-y-2">
          {masters.map((m) => (
            <Card key={m.id}>
              <CardContent className="p-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">
                    {m.label} <span className="text-muted">({m.formatCode})</span>
                  </p>
                  <p className="text-caption text-muted">
                    Firm: {m.firmName} · Created {new Date(m.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(m.id)}
                    className="text-destructive hover:bg-destructive/10"
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Deliverables (engagement-scoped)                                   */
/* ------------------------------------------------------------------ */

function DeliverablesPanel() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const engagementId = searchParams?.get("engagementId") ?? "";
  const [formats, setFormats] = useState<
    Array<{
      id: string;
      code: string;
      label: string;
      status: string;
      versionCount: number;
    }>
  >([]);
  const [templates, setTemplates] = useState<
    Array<{
      id: string;
      formatCode: string;
      label: string;
      versionCount: number;
    }>
  >([]);
  const [versions, setVersions] = useState<
    Array<{
      id: string;
      formatCode: string;
      revision: number;
      status: string;
      variant: string;
      udin: string | null;
      issuedAt: string | null;
      partCount: number;
      templateId: string | null;
    }>
  >([]);
  const [activeFormat, setActiveFormat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (id: string) => {
    if (!id) return;
    setError(null);
    try {
      const [fmts, tmpls] = await Promise.all([
        api<{ formats: typeof formats }>(`/api/organization/engagements/${id}/deliverables?kind=formats`),
        api<{ templates: typeof templates }>(`/api/organization/engagements/${id}/deliverables?kind=templates`),
      ]);
      setFormats(fmts.formats);
      setTemplates(tmpls.templates);
      if (fmts.formats[0]?.code) {
        setActiveFormat(fmts.formats[0].code);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const fetchVersions = useCallback(async (id: string, code: string) => {
    try {
      const res = await api<{ versions: typeof versions }>(
        `/api/organization/engagements/${id}/deliverables?kind=versions&formatCode=${code}`,
      );
      setVersions(res.versions);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void fetchAll(engagementId);
  }, [engagementId, fetchAll]);
  useEffect(() => {
    if (engagementId && activeFormat) void fetchVersions(engagementId, activeFormat);
  }, [engagementId, activeFormat, fetchVersions]);

  if (!engagementId) {
    return (
      <Panel
        title="Engagement deliverables"
        description="Select an engagement from the Organization page to manage its deliverable formats, templates and versions."
      >
        <p className="text-muted">
          No engagement selected. Use the Organization tab to open an engagement, then return here.
        </p>
      </Panel>
    );
  }

  const handleCreateFormat = async () => {
    const label = prompt(`Label for new ${activeFormat} format:`);
    if (!label) return;
    try {
      await api(`/api/organization/engagements/${engagementId}/deliverables`, {
        method: "POST",
        body: JSON.stringify({ action: "create-format", code: activeFormat, label }),
      });
      toast({ title: "Format created", type: "success" });
      fetchAll(engagementId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleCreateTemplate = async () => {
    const label = prompt(`Label for new ${activeFormat} template:`);
    if (!label) return;
    try {
      await api(`/api/organization/engagements/${engagementId}/deliverables`, {
        method: "POST",
        body: JSON.stringify({
          action: "create-template",
          formatCode: activeFormat,
          label,
          body: JSON.stringify({ parts: [], precedents: [], cover: null }),
        }),
      });
      toast({ title: "Template created", type: "success" });
      fetchAll(engagementId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleAction = async (versionId: string, action: string, data?: Record<string, unknown>) => {
    try {
      await api(`/api/organization/engagements/${engagementId}/deliverables`, {
        method: "POST",
        body: JSON.stringify({ action, versionId, ...data }),
      });
      toast({ title: action.charAt(0).toUpperCase() + action.slice(1), type: "success" });
      if (activeFormat) fetchVersions(engagementId, activeFormat);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Panel
      title="Engagement deliverables"
      description="Manage report formats, templates and signed versions for this engagement. Each version is independently reviewed, signed off and issued."
    >
      {error && <ErrorMessage title="Error" message={error} />}
      <div className="mb-4">
        <Select
          label="Format"
          value={activeFormat ?? ""}
          onChange={(e) => {
            setActiveFormat(e.target.value || null);
          }}
          options={formats.map((f) => ({ value: f.code, label: `${f.label} (${f.code})` }))}
          placeholder="Create a format first"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-h3 text-foreground">Formats</h4>
              <Button
                size="sm"
                onClick={handleCreateFormat}
                disabled={!activeFormat || formats.some((f) => f.code === activeFormat)}
              >
                Add format
              </Button>
            </div>
            <ul className="space-y-2">
              {formats.map((f) => (
                <li key={f.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {f.label} <span className="text-muted">({f.code})</span>
                  </span>
                  <Badge variant={f.status === "ACTIVE" ? "success" : "outline"}>{f.status}</Badge>
                </li>
              ))}
              {formats.length === 0 && <p className="text-caption text-muted">No formats yet.</p>}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-h3 text-foreground">Templates</h4>
              <Button size="sm" onClick={handleCreateTemplate} disabled={!activeFormat}>
                Add template
              </Button>
            </div>
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {t.label} <span className="text-muted">({t.formatCode})</span>
                  </span>
                  <Badge variant="outline">{t.versionCount} versions</Badge>
                </li>
              ))}
              {templates.length === 0 && <p className="text-caption text-muted">No templates yet.</p>}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <h4 className="text-h3 text-foreground mb-3">Versions</h4>
            <ul className="space-y-2 max-h-60 overflow-y-auto">
              {versions.map((v) => (
                <li key={v.id} className="p-2 rounded border border-line flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm">
                      rev {v.revision} · {v.variant}
                    </span>
                    <Badge
                      variant={v.status === "ISSUED" ? "success" : v.status === "SIGNED_OFF" ? "default" : "outline"}
                    >
                      {v.status}
                    </Badge>
                  </div>
                  <p className="text-caption text-muted">
                    {v.issuedAt
                      ? `Issued ${new Date(v.issuedAt).toLocaleDateString()}`
                      : v.udin
                        ? `UDIN ${v.udin}`
                        : "Draft"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {v.status === "DRAFT" && (
                      <Button size="sm" variant="ghost" onClick={() => handleAction(v.id, "submit-for-review")}>
                        Submit
                      </Button>
                    )}
                    {v.status === "IN_REVIEW" && (
                      <Button size="sm" variant="ghost" onClick={() => handleAction(v.id, "approve")}>
                        Approve
                      </Button>
                    )}
                    {v.status === "REVIEWED" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleAction(v.id, "sign-off", { signOffRole: "PARTNER" })}
                      >
                        Sign off
                      </Button>
                    )}
                    {v.status === "SIGNED_OFF" && (
                      <Button
                        size="sm"
                        onClick={() =>
                          handleAction(v.id, "issue", {
                            issuedFor: "Client",
                            issuedAtLabel: new Date().toLocaleDateString(),
                          })
                        }
                      >
                        Issue
                      </Button>
                    )}
                    {v.udin && (
                      <Button size="sm" variant="ghost" onClick={() => handleAction(v.id, "verify-udin")}>
                        Verify UDIN
                      </Button>
                    )}
                    {["ISSUED", "SIGNED_OFF", "REVIEWED"].includes(v.status) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleAction(v.id, "withdraw", { reason: "Withdrawn" })}
                      >
                        Withdraw
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleAction(v.id, "assemble", { formatCode: v.formatCode })}
                    >
                      Re-assemble
                    </Button>
                  </div>
                </li>
              ))}
              {versions.length === 0 && (
                <p className="text-caption text-muted">No versions yet. Assemble one from a template.</p>
              )}
            </ul>
          </CardContent>
        </Card>
      </div>
    </Panel>
  );
}
