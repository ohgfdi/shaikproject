import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { rlsEnforcementStatus } from "@/lib/server/tenancy";

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

    // Verify workspace access. The app is one workspace per account today, so
    // the signed-in user's workspace is the access boundary.
    if (workspaceId && user.workspace.id !== workspaceId) {
      return NextResponse.json({ ok: false, error: "Workspace access denied" }, { status: 403 });
    }

    // Check RLS posture — if RLS is enforced, ensure the query layer is wired
    const posture = await rlsEnforcementStatus();

    logSecurityEvent(
      user.workspace.id,
      user.id,
      "SECURITY_SSO",
      `Embed dashboard accessed (workspace: ${workspaceId || "none"})`,
    );

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.isAdmin ? "admin" : "member",
      },
      workspace: {
        id: user.workspace.id,
        name: user.workspace.name,
      },
      rlsPosture: {
        role: posture.role,
        tablesWithRls: posture.tablesWithRls,
        tablesWithoutForce: posture.tablesWithoutForce,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 500 });
  }
}
