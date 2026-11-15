import { TrendingUp } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/primitives";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { requirePageAuth } from "@/lib/auth/guard";
import { fmtPct } from "@/lib/format";
import { activationVerdict, weeklyFunnel, type WeeklyFunnelRow } from "@/lib/server/growth-funnel";
import { practiceStall } from "@/lib/server/practice-funnel";
import { practiceFunnelSnapshot } from "@/lib/server/practice-funnel-query";

export const metadata = { title: "Growth Funnel" };

const VERDICT_STYLE: Record<ReturnType<typeof activationVerdict>, string> = {
  excellent: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  healthy: "bg-accent/12 text-accent-strong",
  "fix-onboarding": "bg-amber/15 text-amber",
  "no-data": "bg-surface-2 text-muted",
};

const VERDICT_LABEL: Record<ReturnType<typeof activationVerdict>, string> = {
  excellent: "Excellent — activation ≥ 60%",
  healthy: "Healthy — activation ≥ 40%",
  "fix-onboarding": "Fix onboarding before spending on traffic (< 40%)",
  "no-data": "No signups in the latest week yet",
};

function fmtRate(value: number | null): string {
  return value === null ? "—" : fmtPct(value * 100, 0);
}

function FunnelRow({ row }: { row: WeeklyFunnelRow }) {
  return (
    <TableRow>
      <TableCell className="font-medium text-foreground">{row.weekOf}</TableCell>
      <TableCell>{row.signups}</TableCell>
      <TableCell>
        {row.activated}
        <span className="ml-1.5 text-muted">({fmtRate(row.activationRate)})</span>
      </TableCell>
      <TableCell>{row.collaborated}</TableCell>
      <TableCell>
        {row.paid}
        <span className="ml-1.5 text-muted">({fmtRate(row.paidRate)})</span>
      </TableCell>
    </TableRow>
  );
}

export default async function GrowthFunnelPage() {
  const ctx = await requirePageAuth();

  // Owner/ADMIN only — the same rule as the API. Everyone else gets an
  // explicit no-access card rather than an error.
  const role = ctx.organizationRole ?? "OWNER";
  const isOperator = role === "OWNER" || role === "ADMIN";

  const rows = isOperator ? await weeklyFunnel(12) : [];
  const practice = isOperator ? await practiceFunnelSnapshot() : null;
  const stall = practice ? practiceStall(practice) : null;
  const latest = rows[rows.length - 1];
  const verdict = activationVerdict(latest?.activationRate ?? null);
  const totals = rows.reduce(
    (acc, r) => ({
      signups: acc.signups + r.signups,
      activated: acc.activated + r.activated,
      collaborated: acc.collaborated + r.collaborated,
      paid: acc.paid + r.paid,
    }),
    { signups: 0, activated: 0, collaborated: 0, paid: 0 },
  );

  return (
    <div>
      <PageHeader
        title="Growth Funnel"
        description="The weekly cohort table that decides whether the product is working: of the users who signed up each week, how many got value (uploaded AND ran an analysis), collaborated, and paid. Computed from the activity trail — no extra tracking."
        actions={
          <span className={`badge ${VERDICT_STYLE[verdict]}`} aria-live="polite">
            {VERDICT_LABEL[verdict]}
          </span>
        }
      />

      {!isOperator ? (
        <Card className="p-6 text-sm text-muted">
          Funnel metrics are operator-only (organization OWNER/ADMIN). Ask your firm&apos;s owner for access.
        </Card>
      ) : (
        <>
          {/* Stage totals across the window */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Signups (12w)", value: totals.signups },
              { label: "Activated", value: totals.activated },
              { label: "Collaborated", value: totals.collaborated },
              { label: "Paid", value: totals.paid },
            ].map((stat) => (
              <Card key={stat.label} className="p-4">
                <p className="text-2xl font-bold text-foreground">{stat.value.toLocaleString()}</p>
                <p className="mt-0.5 text-caption text-muted">{stat.label}</p>
              </Card>
            ))}
          </div>

          {/* Where the pilot actually stalls — the CA-firm value chain. */}
          {practice && stall && (
            <section aria-label="Practice value chain" className="mt-8">
              <h2 className="text-h3 text-foreground">Where the pilot stalls</h2>
              <p className="mt-1 max-w-3xl text-caption text-muted">
                A firm&apos;s value chain is engagement → client portal → filing prepared → filed → reconciled. The
                first missing step is the next thing to build; everything after it is speculation. Counts are read from
                stored rows, never estimated.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                {[
                  { label: "Engagements", value: practice.engagements },
                  { label: "Portal accounts", value: practice.portalAccounts },
                  { label: "Filings prepared", value: practice.preparedFilings },
                  { label: "Transmitted", value: practice.filedFilings },
                  { label: "Reconciled", value: practice.reconciledFilings },
                ].map((stat) => (
                  <Card key={stat.label} className="p-4">
                    <p className="text-2xl font-bold text-foreground">{stat.value.toLocaleString()}</p>
                    <p className="mt-0.5 text-caption text-muted">{stat.label}</p>
                  </Card>
                ))}
              </div>
              <Card className="mt-3 p-4">
                <p className="text-sm font-semibold text-foreground">{stall.summary}</p>
                <p className="mt-1 text-sm text-muted">
                  <span className="font-medium text-foreground">Next build: </span>
                  {stall.nextBuild}
                </p>
                <p className="mt-1 text-caption text-muted">
                  Stage: <code className="rounded bg-surface-2 px-1">{stall.stage}</code>
                </p>
              </Card>
            </section>
          )}

          {/* Weekly cohort table */}
          <h2 className="mt-8 flex items-center gap-2 text-h3 text-foreground">
            <TrendingUp aria-hidden className="size-5 text-accent" />
            Weekly cohorts
          </h2>
          <p className="mt-1 text-caption text-muted">
            Each row is a signup week (Monday, UTC). Rates are attributed to the signup week, not the event week. A dash
            (—) means the denominator was zero — no data, never a fabricated 0%.
          </p>

          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableCell className="font-semibold">Week of</TableCell>
                  <TableCell className="font-semibold">Signups</TableCell>
                  <TableCell className="font-semibold">Activated</TableCell>
                  <TableCell className="font-semibold">Collaborated</TableCell>
                  <TableCell className="font-semibold">Paid</TableCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <FunnelRow key={row.weekOf} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-8 pt-6 border-t border-line">
            <h3 className="text-sm font-semibold text-foreground">Definitions</h3>
            <ul className="mt-2 space-y-1 text-caption text-muted">
              <li>
                <strong className="text-foreground">Activated</strong> — the workspace uploaded a dataset AND ran an
                analysis.
              </li>
              <li>
                <strong className="text-foreground">Collaborated</strong> — added an organization member or published a
                public share link.
              </li>
              <li>
                <strong className="text-foreground">Paid</strong> — holds an active paid (non-free) subscription.
              </li>
              <li>
                Demo accounts (<code>*@aerolexa.local</code>) are excluded from every stage.
              </li>
            </ul>
            <p className="mt-3 text-caption text-muted">
              The plan&apos;s rule of thumb: if activation &lt; 40%, fix onboarding before spending anything on
              acquisition; if paid conversion &lt; 5%, the wedge or pricing is wrong &mdash; not the code.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
