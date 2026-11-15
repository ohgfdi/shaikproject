"use client";

import { CalendarClock, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import type { FirmDueDateDrift } from "@/lib/server/statute-drift";

interface DriftSummary {
  drifts: FirmDueDateDrift[];
  profilesChecked: number;
  unreadableProfiles: number;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function fmtDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFmt.format(date) : iso;
}

/**
 * Stored deadlines vs the calendar as it regenerates today.
 *
 * The detector reports the disagreement; the firm decides. Nothing here moves a
 * date automatically — a corrected notification and a stale profile look
 * identical to software, and only the firm can tell which one it is.
 */
export function DueDateDrift({ onChanged }: { onChanged?: () => void }) {
  const [summary, setSummary] = useState<DriftSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<DriftSummary>("/api/organization/compliance/filings/drift");
      setSummary(data);
      setError(null);
    } catch (err) {
      // A failed drift check must not take the board down; the board still works
      // on stored dates. The message is shown so it is not silently ignored.
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyDate = useCallback(
    async (drift: FirmDueDateDrift) => {
      if (!drift.runId) return;
      setBusyId(drift.taskId);
      setError(null);
      setNotice(null);
      try {
        await api(`/api/organization/compliance/filings/${drift.runId}`, {
          method: "PATCH",
          body: JSON.stringify({
            action: "move-due-date",
            dueDate: drift.generatedDueDate,
            note: `Deadline moved from ${drift.storedDueDate} to ${drift.generatedDueDate} after the statutory calendar was regenerated.`,
          }),
        });
        setNotice(
          `${drift.title}: deadline now ${fmtDate(drift.generatedDueDate)} (was ${fmtDate(drift.storedDueDate)}).`,
        );
        await load();
        onChanged?.();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [load, onChanged],
  );

  if (!summary) return null;
  if (summary.drifts.length === 0 && !error) return null;

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Deadline drift
            <Badge variant="warning">{summary.drifts.length}</Badge>
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Checked {summary.profilesChecked} client profile{summary.profilesChecked === 1 ? "" : "s"}
            {summary.unreadableProfiles > 0
              ? ` · ${summary.unreadableProfiles} unreadable profile${summary.unreadableProfiles === 1 ? "" : "s"} skipped`
              : ""}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          The stored run date and the freshly generated calendar disagree. Move a run only if the
          stored date is the stale one — the app does not pick a winner.
        </p>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {notice ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>
        ) : null}

        <ul className="space-y-2">
          {summary.drifts.map((drift) => (
            <li
              key={`${drift.engagementId}:${drift.taskId}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {drift.title}
                  {drift.clientName ? (
                    <span className="text-muted-foreground"> — {drift.clientName}</span>
                  ) : null}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5" />
                  stored {fmtDate(drift.storedDueDate)} → calendar {fmtDate(drift.generatedDueDate)}
                  <Badge variant={drift.direction === "advanced" ? "critical" : "outline"}>
                    {drift.direction === "advanced"
                      ? `${Math.abs(drift.daysShifted)} day(s) earlier`
                      : `${drift.daysShifted} day(s) later`}
                  </Badge>
                </p>
              </div>
              {drift.runId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === drift.taskId}
                  onClick={() => void applyDate(drift)}
                >
                  {busyId === drift.taskId ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Use generated date
                </Button>
              ) : (
                <Badge variant="outline">No open run</Badge>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
