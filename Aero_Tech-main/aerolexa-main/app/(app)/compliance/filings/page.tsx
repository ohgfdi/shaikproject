import { CheckCircle2, CircleAlert, CircleHelp, CircleSlash } from "lucide-react";

import { FilingBoard } from "@/components/compliance/filing-board";
import { PageHeader } from "@/components/layout/page-header";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guard";
import { getFilingCertification } from "@/lib/server/filing-certification";

export const metadata = { title: "Filing Runs" };

/**
 * The execution half of the compliance calendar: prepared → reviewed →
 * client-approved → filed → acknowledged, with the acknowledgement on record.
 */
const STATE_STYLE = {
  done: { variant: "success", label: "Done" },
  pending: { variant: "warning", label: "Pending" },
  blocked: { variant: "critical", label: "Blocked" },
  "not-applicable": { variant: "info", label: "N/A" },
} as const;

const VERDICT_STYLE = {
  certified: { variant: "success", label: "Certified" },
  pilot: { variant: "warning", label: "Pilot — not certified" },
  simulation: { variant: "info", label: "Offline" },
} as const;

export default async function FilingRunsPage() {
  const ctx = await requirePageAuth();
  const certification = await getFilingCertification(ctx.organization?.id ?? null);
  const verdict = VERDICT_STYLE[certification.verdict];

  return (
    <div>
      <PageHeader
        title="Filing runs"
        description="Every obligation the firm has picked up, who is preparing it, who reviewed it, whether the client approved it, and the ARN/SRN that proves it was filed."
      />

      {/* Certification is evidence, not a setting. The checklist reports what the
          deployment can actually prove; a live gateway with no reconciled filing
          stays a pilot. */}
      <Card className="mt-6">
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-h3 text-foreground">Filing certification</h2>
              <p className="mt-1 text-sm text-muted">{certification.summary}</p>
            </div>
            <Badge variant={verdict.variant}>{verdict.label}</Badge>
          </div>
          <ul className="grid gap-2 md:grid-cols-2">
            {certification.steps.map((step) => {
              const style = STATE_STYLE[step.state];
              return (
                <li key={step.id} className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
                  {step.state === "done" ? (
                    <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : step.state === "blocked" ? (
                    <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
                  ) : step.state === "pending" ? (
                    <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-amber" />
                  ) : (
                    <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{step.label}</p>
                    <p className="text-caption text-muted">{step.detail}</p>
                  </div>
                  <Badge variant={style.variant} className="ml-auto shrink-0">
                    {style.label}
                  </Badge>
                </li>
              );
            })}
          </ul>
          <p className="text-caption text-muted">
            Provider <code className="rounded bg-surface-2 px-1">{certification.provider}</code> · channel{" "}
            <code className="rounded bg-surface-2 px-1">{certification.activeChannel}</code> · live submissions{" "}
            {certification.liveSubmissions} · verified {certification.verifiedFilings}. Operator procedure:{" "}
            <code className="rounded bg-surface-2 px-1">docs/filing-go-live-runbook.md</code>.
          </p>
        </CardContent>
      </Card>

      <div className="mt-6">
        <FilingBoard />
      </div>
    </div>
  );
}
