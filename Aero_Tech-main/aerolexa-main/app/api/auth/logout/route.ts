import { NextResponse } from "next/server";

import { clearSessionCookieDescriptors, readSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logSecurityEvent } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";

export async function POST() {
  try {
    const session = await readSession();
    if (session?.sub) {
      const user = await prisma.user.findUnique({
        where: { id: session.sub },
        select: { email: true, workspace: { select: { id: true } } },
      });
      if (user?.workspace) {
        await logSecurityEvent(user.workspace.id, session.sub, "SECURITY_SIGN_OUT", `${user.email} signed out`);
      }
    }
    const res = NextResponse.json({ ok: true, data: null });
    // Both the current and the pre-rename cookie, so a sign-out on an upgraded
    // install cannot leave a legacy session token behind.
    for (const cookie of clearSessionCookieDescriptors()) {
      res.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    return res;
  } catch (err) {
    // Sign-out must never fail closed: a database hiccup while recording the
    // SECURITY_SIGN_OUT event would otherwise leave the session cookie in
    // place, and the client could not clear it. The audit write is best
    // effort by design — the cookies are the security-relevant part.
    return toErrorResponse(err);
  }
}
