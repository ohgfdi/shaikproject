"use client";

import { Download, FileCheck2, KeyRound, ScrollText, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { WorkingPapersCard, type WorkingPaper, type WorkingPaperIndex } from "@/components/ca/working-papers-card";
import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, apiMutate, errorMessage } from "@/lib/client/api";
import type { DataClassification, PracticeRole } from "@/lib/types";

type BadgeVariant = "default" | "info" | "warning" | "critical" | "success" | "amber" | "outline";

interface EngagementRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
  jurisdiction?: string;
}

interface Retention {
  jurisdiction: string;
  jurisdictionName: string;
  knownJurisdiction: boolean;
  classification: DataClassification;
  legalHold: boolean;
  floorDays: number;
  purgeEligibleAt: string;
  purgeEligible: boolean;
  statutoryBases: string[];
}

interface Posture {
  engagementId: string;
  jurisdiction: string;
  jurisdictionName: string;
  classification: DataClassification;
  retention: Retention;
  counts: Record<string, number>;
}

interface AccessEntry {
  userId: string;
  name: string;
  email: string;
  practiceRole: PracticeRole;
  source: "assigned" | "firm-role";
  assignedAt: string | null;
  isSelf: boolean;
}

interface AccessResponse {
  engagementId: string;
  assignments: AccessEntry[];
  callerRole: PracticeRole;
}

interface ChangeRequest {
  id: string;
  title: string;
  description: string | null;
  rationale: string | null;
  targetType: string;
  targetId: string | null;
  state: string;
  assignedToPracticeRole: PracticeRole;
  signOffRequiredFor: PracticeRole;
  reviewNote: string | null;
  requestedAt: string;
  updatedAt: string;
}

interface LedgerEntry {
  id: string;
  seq: number;
  action: string;
  actorId: string;
  actorPracticeRole: PracticeRole;
  targetType: string;
  targetId: string | null;
  summary: string;
  createdAt: string;
}

interface LedgerResponse {
  entries: LedgerEntry[];
  verification: { valid: boolean; entries: number; brokenAtSeq: number | null; reason: string | null };
}

interface Consent {
  id: string;
  purpose: string;
  subjectRef: string;
  granted: boolean;
  policyVersion: string;
  evidenceNote: string | null;
  createdAt: string;
}

interface ErasurePlan {
  engagementId: string;
  eligible: boolean;
  blockers: string[];
  retention: Retention;
  checklist: { kind: string; label: string; count: number; retained: boolean; note: string }[];
  retainedKinds: string[];
}

const PRACTICE_ROLES: PracticeRole[] = ["PARTNER", "MANAGER", "REVIEWER", "SENIOR", "ASSISTANT", "AUDITOR"];

const PRACTICE_ROLE_OPTIONS = PRACTICE_ROLES.map((r) => ({ value: r, label: r.charAt(0) + r.slice(1).toLowerCase() }));

const CLASSIFICATIONS: DataClassification[] = ["INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

const CONSENT_PURPOSES = ["engagement", "statutory-filing", "cross-border-transfer", "product-improvement"] as const;

const STATE_BADGE: Record<string, BadgeVariant> = {
  DRAFT: "outline",
  REQUESTED: "info",
  IN_REVIEW: "amber",
  CHANGES_REQUESTED: "warning",
  APPROVED: "success",
  REJECTED: "critical",
  IMPLEMENTED: "success",
  SUPERSEDED: "outline",
  SIGNED_OFF: "success",
  REVIEWED: "info",
  ARCHIVED: "outline",
};

function roleBadge(role: PracticeRole): BadgeVariant {
  if (role === "PARTNER") return "success";
  if (role === "MANAGER") return "info";
  if (role === "AUDITOR") return "outline";
  return "default";
}

export function GovernancePanel() {
  const { toast } = useToast();
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [posture, setPosture] = useState<Posture | null>(null);
  const [access, setAccess] = useState<AccessResponse | null>(null);
  const [changes, setChanges] = useState<ChangeRequest[]>([]);
  const [papers, setPapers] = useState<{ workingPapers: WorkingPaper[]; index: WorkingPaperIndex } | null>(null);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [erasure, setErasure] = useState<ErasurePlan | null>(null);

  // Keep the toast callbacks identity-stable: the provider recreates its
  // context value each render, so depending on `toast` directly would re-run
  // every effect (and refetch) on each render.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const notify = useCallback((title: string, message?: string) => {
    toastRef.current({ title, message, type: "success" });
  }, []);
  const fail = useCallback((title: string, err: unknown) => {
    toastRef.current({ title, message: errorMessage(err), type: "error" });
  }, []);

  const loadEngagements = useCallback(async () => {
    try {
      const data = await api<{ engagements: EngagementRow[] }>("/api/organization/engagements");
      setEngagements(data.engagements);
      setSelected((current) => current || data.engagements[0]?.id || "");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const loadGovernance = useCallback(
    async (engagementId: string) => {
      if (!engagementId) return;
      try {
        const [postureRes, accessRes, changesRes, papersRes, ledgerRes, consentRes, erasureRes] = await Promise.all([
          api<Posture>(`/api/organization/engagements/${engagementId}/data-posture`),
          api<AccessResponse>(`/api/organization/engagements/${engagementId}/access`),
          api<{ changeRequests: ChangeRequest[] }>(`/api/organization/engagements/${engagementId}/changes`),
          api<{ workingPapers: WorkingPaper[]; index: WorkingPaperIndex }>(
            `/api/organization/engagements/${engagementId}/working-papers`,
          ),
          api<LedgerResponse>(`/api/organization/engagements/${engagementId}/ledger?limit=50`),
          api<{ consents: Consent[] }>(`/api/organization/engagements/${engagementId}/consents`),
          api<ErasurePlan>(`/api/organization/engagements/${engagementId}/erasure`),
        ]);
        setPosture(postureRes);
        setAccess(accessRes);
        setChanges(changesRes.changeRequests);
        setPapers(papersRes);
        setLedger(ledgerRes);
        setConsents(consentRes.consents);
        setErasure(erasureRes);
      } catch (err) {
        fail("Could not load engagement governance", err);
      }
    },
    [fail],
  );

  useEffect(() => {
    void loadEngagements();
  }, [loadEngagements]);

  useEffect(() => {
    if (selected) void loadGovernance(selected);
  }, [selected, loadGovernance]);

  const reload = () => void loadGovernance(selected);

  if (error) {
    return (
      <section aria-label="Engagement governance">
        <h2 className="text-h2 text-foreground">Engagement governance</h2>
        <ErrorMessage title="Could not load engagements" message={error} />
      </section>
    );
  }

  if (engagements.length === 0) {
    return (
      <section aria-label="Engagement governance">
        <h2 className="text-h2 text-foreground">Engagement governance</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Create an organization and a client engagement first. Governance controls — practice roles, working papers,
          change control, retention and export/erasure — appear here once a client exists.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Engagement governance" className="flex flex-col gap-4">
      <div>
        <h2 className="text-h2 text-foreground">Engagement governance</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Per-client access, audit-grade change control and jurisdiction-aware data handling. Every action here is
          written to the engagement&apos;s immutable change ledger.
        </p>
      </div>

      <Field label="Client engagement">
        <Select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          options={engagements.map((e) => ({ value: e.id, label: `${e.name}${e.code ? ` · ${e.code}` : ""}` }))}
        />
      </Field>

      {posture && (
        <PostureCard
          posture={posture}
          onSaved={reload}
          onError={(e) => fail("Retention update failed", e)}
          onOk={() => notify("Retention posture updated")}
        />
      )}

      {access && <AccessCard access={access} onChanged={reload} onError={(e) => fail("Access update failed", e)} />}

      <ChangeControlCard
        engagementId={selected}
        changes={changes}
        onChanged={reload}
        onError={(e) => fail("Change control failed", e)}
        onOk={(m) => notify(m)}
      />

      <WorkingPapersCard
        engagementId={selected}
        papers={papers}
        onChanged={reload}
        onError={(e) => fail("Working-paper action failed", e)}
        onOk={(m) => notify(m)}
      />

      <ConsentCard
        engagementId={selected}
        consents={consents}
        onChanged={reload}
        onError={(e) => fail("Consent update failed", e)}
        onOk={() => notify("Consent recorded")}
      />

      {ledger && <LedgerCard ledger={ledger} />}

      <ExportCard
        engagementId={selected}
        onError={(e) => fail("Export blocked", e)}
        onOk={() => notify("Export prepared")}
      />

      {erasure && (
        <ErasureCard
          engagementId={selected}
          plan={erasure}
          onChanged={reload}
          onError={(e) => fail("Erasure action failed", e)}
          onOk={(m) => notify(m)}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Posture + retention                                               */
/* ---------------------------------------------------------------- */

function PostureCard({
  posture,
  onSaved,
  onOk,
  onError,
}: {
  posture: Posture;
  onSaved: () => void;
  onOk: () => void;
  onError: (e: unknown) => void;
}) {
  const [jurisdiction, setJurisdiction] = useState(posture.jurisdiction);
  const [classification, setClassification] = useState<DataClassification>(posture.classification);
  const [legalHold, setLegalHold] = useState(posture.retention.legalHold);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setJurisdiction(posture.jurisdiction);
    setClassification(posture.classification);
    setLegalHold(posture.retention.legalHold);
  }, [posture]);

  const save = async () => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${posture.engagementId}/data-posture`,
        {
          method: "PATCH",
          body: JSON.stringify({ jurisdiction, dataClassification: classification, legalHold, reason }),
        },
        `/api/organization/engagements/${posture.engagementId}`,
      );
      setReason("");
      onSaved();
      onOk();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ShieldCheck aria-hidden className="size-4" />
          Jurisdiction, confidentiality &amp; retention
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <MiniStat label="Jurisdiction" value={posture.retention.jurisdictionName} />
          <MiniStat label="Retention floor" value={`${posture.retention.floorDays} days`} />
          <MiniStat label="Purge eligible" value={posture.retention.purgeEligible ? "Yes" : "No"} />
          <MiniStat label="Legal hold" value={posture.retention.legalHold ? "Active" : "None"} />
        </div>
        <p className="text-caption text-muted">
          Earliest purge: {posture.retention.purgeEligibleAt.slice(0, 10)}
          {posture.retention.knownJurisdiction ? "" : " · unrecognized jurisdiction (strictest rules apply)"}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Jurisdiction code">
            <Input
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              placeholder="IN"
              maxLength={4}
            />
          </Field>
          <Field label="Confidentiality">
            <Select
              value={classification}
              onChange={(e) => setClassification(e.target.value as DataClassification)}
              options={CLASSIFICATIONS.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Reason for change" helper="Recorded in the change ledger.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. client instruction" />
          </Field>
        </div>
        <Checkbox
          label="Legal hold"
          description="Freezes erasure/purge regardless of the retention window (live audit, investigation or dispute)."
          checked={legalHold}
          onChange={setLegalHold}
        />
        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={busy || reason.trim().length < 3}>
            Save retention posture
          </Button>
        </div>

        <details className="text-caption text-muted">
          <summary className="cursor-pointer">Statutory retention bases</summary>
          <ul className="mt-1 list-disc pl-5">
            {posture.retention.statutoryBases.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Access                                                            */
/* ---------------------------------------------------------------- */

function AccessCard({
  access,
  onChanged,
  onError,
}: {
  access: AccessResponse;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const grant = async (userId: string, practiceRole: PracticeRole) => {
    setBusyId(userId);
    try {
      await apiMutate(
        `/api/organization/engagements/${access.engagementId}/access`,
        { method: "POST", body: JSON.stringify({ userId, practiceRole }) },
        `/api/organization/engagements/${access.engagementId}`,
      );
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (userId: string) => {
    setBusyId(userId);
    try {
      await apiMutate(
        `/api/organization/engagements/${access.engagementId}/access?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
        `/api/organization/engagements/${access.engagementId}`,
      );
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusyId(null);
    }
  };

  const canManage = access.callerRole === "PARTNER" || access.callerRole === "MANAGER";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound aria-hidden className="size-4" />
            Client access
          </div>
          <Badge variant={roleBadge(access.callerRole)}>You: {access.callerRole}</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-caption text-muted">
                <th className="py-1.5 pr-3 font-medium">Member</th>
                <th className="py-1.5 pr-3 font-medium">Practice role</th>
                <th className="py-1.5 pr-3 font-medium">Source</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {access.assignments.map((a) => (
                <tr key={a.userId} className="border-t border-line/60">
                  <td className="py-1.5 pr-3">
                    <div className="text-foreground">{a.name}</div>
                    <div className="text-caption text-muted">{a.email}</div>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Select
                      aria-label={`Practice role for ${a.name}`}
                      value={a.practiceRole}
                      disabled={!canManage || busyId === a.userId}
                      onChange={(e) => void grant(a.userId, e.target.value as PracticeRole)}
                      options={PRACTICE_ROLE_OPTIONS}
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <Badge variant={a.source === "assigned" ? "info" : "outline"}>
                      {a.source === "assigned" ? "Assigned" : "Firm role"}
                    </Badge>
                  </td>
                  <td className="py-1.5">
                    {a.source === "assigned" && canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === a.userId}
                        onClick={() => void revoke(a.userId)}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!canManage && (
          <p className="text-caption text-muted">Only a partner or manager can change who has access to this client.</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Change control                                                    */
/* ---------------------------------------------------------------- */

const TRANSITIONS: Record<string, { action: string; label: string; variant?: "primary" | "danger" | "ghost" }[]> = {
  DRAFT: [{ action: "submit", label: "Submit for review" }],
  CHANGES_REQUESTED: [{ action: "submit", label: "Resubmit" }],
  REQUESTED: [
    { action: "review", label: "Start review" },
    { action: "reject", label: "Reject", variant: "danger" },
  ],
  IN_REVIEW: [
    { action: "approve", label: "Approve & sign off" },
    { action: "request-changes", label: "Request changes", variant: "ghost" },
    { action: "reject", label: "Reject", variant: "danger" },
  ],
  APPROVED: [{ action: "implement", label: "Mark implemented" }],
};

function ChangeControlCard({
  engagementId,
  changes,
  onChanged,
  onOk,
  onError,
}: {
  engagementId: string;
  changes: ChangeRequest[];
  onChanged: () => void;
  onOk: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [targetType, setTargetType] = useState("clientData");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/changes`,
        { method: "POST", body: JSON.stringify({ title, rationale, targetType }) },
        `/api/organization/engagements/${engagementId}`,
      );
      setTitle("");
      setRationale("");
      onChanged();
      onOk("Change request raised");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const transition = async (id: string, action: string) => {
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/changes/${id}`,
        { method: "PATCH", body: JSON.stringify({ action }) },
        `/api/organization/engagements/${engagementId}`,
      );
      onChanged();
      onOk("Change request updated");
    } catch (err) {
      onError(err);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FileCheck2 aria-hidden className="size-4" />
          Change control
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="What is changing?">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Correct GSTIN on client master"
            />
          </Field>
          <Field label="Why? (required before review)">
            <Input
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Mismatch with registration certificate"
            />
          </Field>
          <Field label="Target type">
            <Select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              options={[
                { value: "clientData", label: "Client data" },
                { value: "clientMaster", label: "Client master" },
                { value: "workingPaper", label: "Working paper" },
                { value: "dataset", label: "Dataset" },
                { value: "book", label: "Book of accounts" },
              ]}
            />
          </Field>
        </div>
        <div>
          <Button onClick={create} disabled={busy || title.trim().length < 3}>
            Raise change request
          </Button>
        </div>

        <ul className="flex flex-col gap-2">
          {changes.length === 0 && <li className="text-caption text-muted">No change requests yet.</li>}
          {changes.map((c) => (
            <li key={c.id} className="rounded-md border border-line bg-surface-2/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATE_BADGE[c.state] ?? "outline"}>{c.state}</Badge>
                <span className="text-sm font-medium text-foreground">{c.title}</span>
                <span className="text-caption text-muted">
                  {c.targetType} · sign-off: {c.signOffRequiredFor}
                </span>
              </div>
              {c.rationale && <p className="mt-1 text-caption text-muted">Why: {c.rationale}</p>}
              {c.reviewNote && <p className="mt-1 text-caption text-muted">Review: {c.reviewNote}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {(TRANSITIONS[c.state] ?? []).map((t) => (
                  <Button
                    key={t.action}
                    size="sm"
                    variant={t.variant ?? "secondary"}
                    onClick={() => void transition(c.id, t.action)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Consents                                                          */
/* ---------------------------------------------------------------- */

function ConsentCard({
  engagementId,
  consents,
  onChanged,
  onOk,
  onError,
}: {
  engagementId: string;
  consents: Consent[];
  onChanged: () => void;
  onOk: () => void;
  onError: (e: unknown) => void;
}) {
  const [purpose, setPurpose] = useState<string>("statutory-filing");
  const [subjectRef, setSubjectRef] = useState("");
  const [busy, setBusy] = useState(false);

  const record = async (granted: boolean) => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/consents`,
        { method: "POST", body: JSON.stringify({ purpose, subjectRef, granted }) },
        `/api/organization/engagements/${engagementId}`,
      );
      setSubjectRef("");
      onChanged();
      onOk();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">Client consent (append-only proof)</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Purpose">
            <Select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              options={CONSENT_PURPOSES.map((p) => ({ value: p, label: p }))}
            />
          </Field>
          <Field label="Who consented" helper="A signatory role label is enough.">
            <Input value={subjectRef} onChange={(e) => setSubjectRef(e.target.value)} placeholder="Client CFO" />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || subjectRef.trim().length < 2} onClick={() => void record(true)}>
            Record consent
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || subjectRef.trim().length < 2}
            onClick={() => void record(false)}
          >
            Record refusal
          </Button>
        </div>
        <ul className="flex flex-col gap-1">
          {consents.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-caption text-muted">
              <Badge variant={c.granted ? "success" : "critical"}>{c.granted ? "Granted" : "Refused"}</Badge>
              <span>{c.purpose}</span>
              <span>· {c.subjectRef}</span>
              <span>· {c.createdAt.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Ledger                                                            */
/* ---------------------------------------------------------------- */

function LedgerCard({ ledger }: { ledger: LedgerResponse }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ScrollText aria-hidden className="size-4" />
            Immutable change ledger
          </div>
          <Badge variant={ledger.verification.valid ? "success" : "critical"}>
            {ledger.verification.valid ? "Chain verified" : `Tampered at seq ${ledger.verification.brokenAtSeq}`}
          </Badge>
          <span className="text-caption text-muted">{ledger.verification.entries} entries</span>
        </div>
        {!ledger.verification.valid && ledger.verification.reason && (
          <p className="text-caption text-danger">{ledger.verification.reason}</p>
        )}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {ledger.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-2 border-b border-line/40 py-1 text-caption">
              <span className="font-mono text-muted">#{e.seq}</span>
              <Badge variant="outline">{e.actorPracticeRole}</Badge>
              <span className="text-foreground">{e.summary}</span>
              <span className="text-muted">{e.createdAt.slice(0, 19).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Export                                                            */
/* ---------------------------------------------------------------- */

function ExportCard({
  engagementId,
  onOk,
  onError,
}: {
  engagementId: string;
  onOk: () => void;
  onError: (e: unknown) => void;
}) {
  const [reason, setReason] = useState("");
  const [targetJurisdiction, setTargetJurisdiction] = useState("");
  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const result = await apiMutate<Record<string, unknown>>(
        `/api/organization/engagements/${engagementId}/export`,
        {
          method: "POST",
          body: JSON.stringify({ reason, targetJurisdiction: targetJurisdiction || undefined, includeIdentifiers }),
        },
        `/api/organization/engagements/${engagementId}`,
      );
      setPkg(result);
      onOk();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!pkg) return;
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "engagement-governance-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Download aria-hidden className="size-4" />
          Controlled export
        </div>
        <p className="text-caption text-muted">
          Consent, cross-border and role checks run first. Taxpayer identifiers are redacted unless you are a
          partner/manager and explicitly request full values; cross-border exports are always redacted.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reason for export">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Client requested their file"
            />
          </Field>
          <Field label="Target jurisdiction (blank = domestic)">
            <Input
              value={targetJurisdiction}
              onChange={(e) => setTargetJurisdiction(e.target.value)}
              placeholder="IN"
              maxLength={4}
            />
          </Field>
        </div>
        <Checkbox
          label="Include full taxpayer identifiers"
          description="Partner/manager only; never applied to a cross-border export."
          checked={includeIdentifiers}
          onChange={setIncludeIdentifiers}
        />
        <div className="flex gap-2">
          <Button onClick={run} disabled={busy || reason.trim().length < 3}>
            Prepare export
          </Button>
          {pkg && (
            <Button variant="secondary" onClick={download}>
              Download JSON
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- */
/* Erasure                                                           */
/* ---------------------------------------------------------------- */

function ErasureCard({
  engagementId,
  plan,
  onChanged,
  onOk,
  onError,
}: {
  engagementId: string;
  plan: ErasurePlan;
  onChanged: () => void;
  onOk: (message: string) => void;
  onError: (e: unknown) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/erasure`,
        { method: "POST", body: JSON.stringify({ reason }) },
        `/api/organization/engagements/${engagementId}`,
      );
      onChanged();
      onOk("Erasure requested and recorded in the ledger");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    setBusy(true);
    try {
      await apiMutate(
        `/api/organization/engagements/${engagementId}/erasure`,
        { method: "PUT", body: JSON.stringify({ reason, confirm, overrideRetention: override }) },
        `/api/organization/engagements/${engagementId}`,
      );
      onChanged();
      onOk("Client data erased; the audit ledger and consent proof were retained");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Trash2 aria-hidden className="size-4" />
          Retention &amp; erasure
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={plan.eligible ? "success" : "warning"}>
            {plan.eligible ? "Eligible for erasure" : "Retention active"}
          </Badge>
          {plan.retention.legalHold && <Badge variant="critical">Legal hold</Badge>}
        </div>
        {plan.blockers.length > 0 && (
          <ul className="list-disc pl-5 text-caption text-muted">
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <ul className="flex flex-col gap-1 text-caption text-muted">
          {plan.checklist.map((c) => (
            <li key={c.kind}>
              {c.label}: {c.count}
              {c.retained ? " (retained — audit proof)" : ""}
              {c.note ? ` — ${c.note}` : ""}
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reason">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Client disengaged; data to be removed"
            />
          </Field>
          <Field label="Confirm (engagement name or code)">
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        <Checkbox
          label="Override the retention floor"
          description="Partner-only. Records the override and its reason in the ledger."
          checked={override}
          onChange={setOverride}
        />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={request} disabled={busy || reason.trim().length < 5}>
            Request erasure
          </Button>
          <Button
            variant="danger"
            onClick={execute}
            disabled={busy || reason.trim().length < 5 || confirm.trim().length < 2}
          >
            Execute erasure
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface-2/60 px-3 py-2">
      <div className="text-sm font-medium text-foreground">{value}</div>
      <div className="text-caption text-muted">{label}</div>
    </div>
  );
}
