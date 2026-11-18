"use client";

import { useCallback, useState, useEffect } from "react";

import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface ComplianceProfile {
  firmName: string;
  licenseNumber: string | null;
  panNumber: string | null;
  registrationDate: string | null;
  contactPerson: string | null;
  contactPhone: string | null;
  email: string | null;
}

interface ComplianceStatus {
  engagementId: string;
  currentYear: string;
  complianceFiled: boolean;
  lastFiled: string | null;
  nextDeadline: string | null;
  daysUntilDeadline: number | null;
  status: "compliant" | "pending" | "overdue" | "at-risk";
  lastReminderSent: string | null;
  nextReminderDue: string | null;
}

interface ComplianceProfileCardProps {
  engagementId: string;
  showActions?: boolean;
}

export function ComplianceProfileCard({ engagementId }: ComplianceProfileCardProps) {
  const [profile, setProfile] = useState<ComplianceProfile | null>(null);
  const [status, setStatus] = useState<ComplianceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profileData = await api<{ profile: ComplianceProfile }>(
        `/api/organization/engagements/${engagementId}/compliance/profile`,
        { credentials: "include" as const }
      );
      if (profileData?.profile) {
        setProfile(profileData.profile);
      }

      const statusData = await api<{ status: ComplianceStatus }>(
        `/api/organization/engagements/${engagementId}/compliance/status`,
        { credentials: "include" as const }
      );
      if (statusData?.status) {
        setStatus(statusData.status);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (!profile && !status && loading) {
    return (
      <Card>
        <CardContent className="p-4 text-center text-muted">Loading compliance profile…</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-danger">{error}</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        {profile && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-caption text-muted uppercase">Firm name</p>
              <p className="text-foreground font-medium">{profile.firmName}</p>
            </div>
            {profile.licenseNumber && (
              <div>
                <p className="text-caption text-muted uppercase">License number</p>
                <p className="text-caption text-muted">{profile.licenseNumber}</p>
              </div>
            )}
            {profile.panNumber && (
              <div>
                <p className="text-caption text-muted uppercase">PAN</p>
                <p className="text-foreground font-medium">{profile.panNumber}</p>
              </div>
            )}
            {profile.registrationDate && (
              <div>
                <p className="text-caption text-muted uppercase">Registration date</p>
                <p className="text-caption text-muted">{new Date(profile.registrationDate).toLocaleDateString()}</p>
              </div>
            )}
          </div>
        )}

        {status && (
          <div className="mt-4 p-3 rounded-md bg-surface-2/50" style={{ borderWidth: "2px" }}>
            <p className="text-caption text-muted uppercase">Status</p><Badge variant={status.status === "compliant" ? "success" : status.status === "pending" ? "warning" : status.status === "overdue" ? "amber" : "info"}>
              {status.status === "compliant" ? "Compliant" : status.status === "pending" ? "Pending" : status.status === "overdue" ? "Overdue" : "At-risk"}</Badge>
            <p className="text-caption text-muted uppercase">Current year</p>
            <p>{status.currentYear}</p>
            <p className="text-caption text-muted uppercase">Filed</p>
            <p>{status.complianceFiled ? "Yes" : "No"}</p>
            <p className="text-caption text-muted uppercase">Next deadline</p>
            <p>{status.nextDeadline || "—"}</p>
          </div>
        )}

        {!profile && !status && (
          <p className="text-caption text-muted">No compliance profile data for this engagement.</p>
        )}
      </CardContent>
    </Card>
  );
}