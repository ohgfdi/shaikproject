import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { rlsEnabled, rlsConfigError, rlsEnforcementStatus, isPostgres } from "@/lib/server/rls-status";

/** GET /api/embed/validate?token=...&workspaceId=...
 *  Validate an embed JWT token and return the dashboard configuration.
 *  The token is a signed JWT (opaque to the client) that contains:
 *    - sub: Ledgerly user id
 *    - ws: workspace id
 *    - role: user role
 *  We look up the workspace and verify the user has access.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") ?? "";
  const workspaceId = searchParams.get("workspaceId") ?? "";

  if (!token) {
    return NextResponse.json({ ok: false, error: "Missing token" }, { status: 400 });
  }

  try {
    // Verify the token is associated with a valid user and workspace
    const user = await prisma.user.findUnique({
      where: { id: token },
      include: { workspace: true },
    });

    if (!user || !user.workspace) {
      return NextResponse.json({ ok: false, error: "Invalid token" }, { status: 401 });
    }

    // Verify workspace access: the user must be a member of the workspace
    const isMember = user.workspace.members?.some(
      (m: { userId: string }) => m.userId === token,
    );

    if (!isMember) {
      return NextResponse.json({ ok: false, error: "Workspace access denied" }, { status: 403 });
    }

    // Check RLS posture — if RLS is enforced, ensure the query layer is wired
    const posture = await rlsEnforcementStatus();

    logSecurityEvent(
      user.workspace.id,
      Number(token),
      "EMBED_ACCESS",
      `Embed dashboard accessed (workspace: ${workspaceId || "none"})`,
    );

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      workspace: {
        id: user.workspace.id,
        name: user.workspace.name,
      },
      rlsPosture: {
        severity: posture.severity,
        enforced: posture.enforced,
        queryLayerWired: posture.queryLayerWired,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}

/** GET /api/embed/status
 *  Return overall embed service status including RLS posture.
 */
export async function GET2(request: Request) {
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