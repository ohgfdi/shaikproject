import { NextResponse } from "next/server";

import { rlsConfigError, rlsEnabled, rlsEnforcementStatus } from "@/lib/server/rls-status";

/** GET /api/embed/status — overall embed service status including RLS posture. */
export async function GET(_request: Request) {
  const posture = await rlsEnforcementStatus();

  return NextResponse.json({
    rlsEnabled: rlsEnabled(),
    rlsConfigError: rlsConfigError(),
    rlsPosture: {
      severity: posture.severity,
      summary: posture.summary,
      remedy: posture.remedy,
    },
    ssoEnabled: Boolean(process.env.SSO_ENABLED),
  });
}
