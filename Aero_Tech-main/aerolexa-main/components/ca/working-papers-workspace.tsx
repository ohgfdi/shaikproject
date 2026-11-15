"use client";

import { ClipboardCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { WorkingPapersCard, type WorkingPaper, type WorkingPaperIndex } from "@/components/ca/working-papers-card";
import { Field, Select } from "@/components/ui/form";
import { Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface EngagementRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

/**
 * Working papers for an engagement, reachable from the practice nav instead of
 * only from Settings → Governance. Vouching, ticking and sampling all land here:
 * a paper is created against the SA 230 index, submitted, reviewed and signed
 * off, and the binder index says which refs are still missing.
 */
export function WorkingPapersWorkspace() {
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [selected, setSelected] = useState("");
  const [papers, setPapers] = useState<{ workingPapers: WorkingPaper[]; index: WorkingPaperIndex } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadEngagements = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ engagements: EngagementRow[] }>("/api/organization/engagements");
      setEngagements(data.engagements ?? []);
      setSelected((current) => current || data.engagements?.[0]?.id || "");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEngagements();
  }, [loadEngagements]);

  const loadPapers = useCallback(async (engagementId: string) => {
    if (!engagementId) return;
    try {
      const data = await api<{ workingPapers: WorkingPaper[]; index: WorkingPaperIndex }>(
        `/api/organization/engagements/${engagementId}/working-papers`,
      );
      setPapers(data);
      setError(null);
    } catch (err) {
      setPapers(null);
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadPapers(selected);
  }, [selected, loadPapers]);

  if (loading) return <p className="text-sm text-muted">Loading engagements…</p>;

  if (error && engagements.length === 0) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-foreground">Working papers need a client engagement.</p>
          <p className="mt-1 text-caption text-muted">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (engagements.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ClipboardCheck aria-hidden className="size-4" />
            No client engagements yet
          </p>
          <p className="text-caption text-muted">
            Create an organization and a client engagement first; working papers are filed against an engagement so one
            client&apos;s audit file can never be mixed into another&apos;s.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:max-w-md">
        <Field label="Client engagement">
          <Select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            options={engagements.map((e) => ({ value: e.id, label: `${e.name}${e.code ? ` · ${e.code}` : ""}` }))}
          />
        </Field>
      </div>

      {message && (
        <p className="rounded-md border border-emerald/40 bg-emerald/10 px-3 py-2 text-sm text-foreground">{message}</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      <WorkingPapersCard
        engagementId={selected}
        papers={papers}
        onChanged={() => void loadPapers(selected)}
        onOk={setMessage}
        onError={(err) => setError(errorMessage(err))}
      />
    </div>
  );
}
