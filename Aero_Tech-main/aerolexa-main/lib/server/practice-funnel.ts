/**
 * Practice (CA-firm) funnel — where a pilot actually stalls.
 *
 * The growth funnel answers "did a signup get value from analytics". A firm's
 * value chain is different and it is the one the pilot is bought for:
 *
 *   engagement created → client invited to the portal → a filing prepared
 *   → a filing transmitted → the acknowledgement reconciled
 *
 * Counting each step is what turns "the pilot feels slow" into a decision:
 * the first missing step names the next thing to build, and nothing else.
 *
 * Pure rules, DB-free counts, honest zeroes: an empty install reports
 * `no-clients`, never a fabricated conversion rate. The database reads live in
 * `practice-funnel-query.ts` so this module stays importable without Prisma.
 */

export interface PracticeCounts {
  engagements: number;
  /** Non-revoked client-portal accounts. */
  portalAccounts: number;
  /** Compliance filing runs that exist (any stage). */
  preparedFilings: number;
  /** Runs that reached a portal (`filedAt` set). */
  filedFilings: number;
  /** Runs whose acknowledgement reconciled (`verificationStatus = verified`). */
  reconciledFilings: number;
}

export type PracticeStage =
  "no-clients" | "no-portal" | "no-filings" | "no-live-filings" | "no-reconciliation" | "complete";

export interface PracticeStall {
  stage: PracticeStage;
  /** The operator-facing sentence: what is missing, in order. */
  summary: string;
  /** The one branch of the roadmap this evidence supports. */
  nextBuild: string;
}

export function practiceStall(counts: PracticeCounts): PracticeStall {
  if (counts.engagements === 0) {
    return {
      stage: "no-clients",
      summary: "No client engagement exists yet, so nothing downstream has been exercised.",
      nextBuild: "Client onboarding: bulk engagement import and the first-file welcome path.",
    };
  }
  if (counts.portalAccounts === 0) {
    return {
      stage: "no-portal",
      summary: `${counts.engagements} engagement(s) exist but no client has an active portal account.`,
      nextBuild: "Portal invitation delivery and the client-side upload/approval loop.",
    };
  }
  if (counts.preparedFilings === 0) {
    return {
      stage: "no-filings",
      summary: `${counts.portalAccounts} client(s) are on the portal but no filing has been prepared.`,
      nextBuild: "Filing preparation: compliance calendar → run → reviewer sign-off.",
    };
  }
  if (counts.filedFilings === 0) {
    return {
      stage: "no-live-filings",
      summary: `${counts.preparedFilings} filing(s) were prepared but none transmitted (still shadow/simulation).`,
      nextBuild: "Live channel certification: one reconciled submission per channel, then per-client rollout.",
    };
  }
  if (counts.reconciledFilings === 0) {
    return {
      stage: "no-reconciliation",
      summary: `${counts.filedFilings} filing(s) transmitted but none reconciled against the portal.`,
      nextBuild: "Reconciliation worklist: match the returned ack/IRN and surface mismatches with a remedy.",
    };
  }
  return {
    stage: "complete",
    summary: `${counts.reconciledFilings} filing(s) reconciled end to end — the value chain is proven.`,
    nextBuild: "Retention and expansion: repeat delivery, templates, and the second client per firm.",
  };
}
