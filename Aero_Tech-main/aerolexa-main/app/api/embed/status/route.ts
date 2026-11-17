import { NextResponse } from "next/server";

import { rlsConfigError, rlsEnabled, rlsEnforcementStatus } from "@/lib/server/tenancy";

/** GET /api/embed/status — overall embed service status including RLS posture. */
export async function GET(_request: Request) {
  const posture = await rlsEnforcementStatus();

  return NextResponse.json({
    rlsEnabled: rlsEnabled(),
    rlsConfigError: rlsConfigError(),
    rlsPosture: {
      role: posture.role,
      tablesWithRls: posture.tablesWithRls,
      tablesWithoutForce: posture.tablesWithoutForce,
    },
    ssoEnabled: Boolean(process.env.SSO_ENABLED),
  });
}
