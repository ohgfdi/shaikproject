"use client";

import { useState, useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface PracticeRole {
  userId: string;
  name: string;
  role: "PARTNER" | "MANAGER" | "REVIEWER" | "SENIOR" | "ASSISTANT" | "AUDITOR";
}

interface EngagementAccess {
  engagementId: string;
  engagementName: string;
  practiceRole: "PARTNER" | "MANAGER" | "REVIEWER" | "SENIOR" | "ASSISTANT" | "AUDITOR";
  canEdit: boolean;
  canViewDocuments: boolean;
  canAssignPapers: boolean;
  canDownloadDeliverables: boolean;
  teamMembers: { userId: string; name: string; role: PracticeRole["role"] }[];
}

interface EngagementAccessPanelProps {
  engagementId: string;
  engagementName: string;
}

export function EngagementAccessPanel({ engagementId, engagementName }: EngagementAccessPanelProps) {
  const [access, setAccess] = useState<EngagementAccess | null>(null);
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState<"PARTNER" | "MANAGER" | "REVIEWER" | "SENIOR" | "ASSISTANT" | "AUDITOR">("MANAGER");
  const [busy, setBusy] = useState(false);
  const [, setError] = useState<string | null>(null);

  // Load access and roles when component mounts
  useEffect(() => {
    void loadAccess();
  }, [engagementId]);

  const loadAccess = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ access: EngagementAccess }>(
        `/api/organization/engagements/${engagementId}/access`,
      );
      setAccess(data.access);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/organization/engagements/${engagementId}/access`, {
        method: "POST",
        body: JSON.stringify({ name: memberName, role: memberRole }),
      });
      setMemberName("");
      setMemberRole("MANAGER");
      await loadAccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/organization/engagements/${engagementId}/access/${userId}`, {
        method: "DELETE",
      });
      await loadAccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canEdit = useMemo(() => {
    return access?.practiceRole === "PARTNER" || access?.practiceRole === "MANAGER";
  }, [access]);

  if (!access) {
    return (
      <Card>
        <CardContent className="p-4 text-center text-muted">
          Loading engagement access…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Engagement Access — {engagementName}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Access summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
          <div>
            <p className="text-caption text-muted uppercase">Practice role</p>
            <p className="text-foreground font-medium">{access.practiceRole}</p>
          </div>
          <div>
            <p className="text-caption text-muted uppercase">Can edit</p>
            <p className={access.canEdit ? "text-emerald-600" : "text-red-600"}>
              {access.canEdit ? "Yes" : "No"}
            </p>
          </div>
          <div>
            <p className="text-caption text-muted uppercase">Can view documents</p>
            <p className={access.canViewDocuments ? "text-emerald-600" : "text-red-600"}>
              {access.canViewDocuments ? "Yes" : "No"}
            </p>
          </div>
          <div>
            <p className="text-caption text-muted uppercase">Can assign papers</p>
            <p className={access.canAssignPapers ? "text-emerald-600" : "text-red-600"}>
              {access.canAssignPapers ? "Yes" : "No"}
            </p>
          </div>
          <div>
            <p className="text-caption text-muted uppercase">Can download deliverables</p>
            <p className={access.canDownloadDeliverables ? "text-emerald-600" : "text-red-600"}>
              {access.canDownloadDeliverables ? "Yes" : "No"}
            </p>
          </div>
        </div>

        {/* Team members list */}
        {access.teamMembers.length > 0 ? (
          <div className="mt-4">
            <p className="text-caption text-muted uppercase">Team members</p>
            <div className="space-y-2">
              {access.teamMembers.map((member) => (
                <div
                  key={member.userId}
                  className="flex items-center justify-between rounded-md border border-line bg-surface-2/30 p-3"
                >
                  <span className="font-medium text-foreground">{member.name}</span>
                  <span className="text-caption text-muted">{member.role}</span>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemoveMember(member.userId)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-caption text-muted mt-4">
            No team members assigned. Firm roles still grant access, but assigning explicit practice roles
            makes access control visible.
          </p>
        )}

        {/* Add member form (only for partners/managers) */}
        {canEdit ? (
          <div className="mt-4">
            <p className="text-caption text-muted uppercase">Add team member</p>
            <form onSubmit={handleAddMember} className="grid gap-2 sm:grid-cols-3 max-w-md pt-2">
              <Field label="Name" required>
                <Input
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  placeholder="e.g. R. Iyer"
                  required
                />
              </Field>
              <Field label="Role">
                <Select
                  value={memberRole}
                  onChange={(e) =>
                    setMemberRole(
                      e.target.value as "PARTNER" | "MANAGER" | "REVIEWER" | "SENIOR" | "ASSISTANT" | "AUDITOR"
                    )
                  }
                  options={[
                    { value: "PARTNER", label: "Partner" },
                    { value: "MANAGER", label: "Manager" },
                    { value: "REVIEWER", label: "Reviewer" },
                    { value: "SENIOR", label: "Senior" },
                    { value: "ASSISTANT", label: "Assistant" },
                    { value: "AUDITOR", label: "Auditor (read-only)" },
                  ]}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy ? "Adding…" : "Add member"}
              </Button>
            </form>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}