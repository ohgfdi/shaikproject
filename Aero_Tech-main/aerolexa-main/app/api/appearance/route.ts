import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { readJsonBody, toErrorResponse } from "@/lib/server/api";
import { ACCENT_COOKIE, THEME_COOKIE, ACCENTS, type AccentName, type ThemeName } from "@/lib/theme";

const schema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  accent: z.enum(ACCENTS.map((a) => a.value) as [AccentName, ...AccentName[]]).optional(),
});

/**
 * Persist display preferences (theme + accent) as short-lived cookies.
 * The root layout reads these cookies server-side, so the client refreshes
 * after calling this endpoint to re-render with the new look.
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const res = NextResponse.json({ ok: true, data: { saved: true } });
    if (body.theme) {
      res.cookies.set(THEME_COOKIE, body.theme satisfies ThemeName, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1 year
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }
    if (body.accent) {
      res.cookies.set(ACCENT_COOKIE, body.accent satisfies AccentName, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    }
    return res;
  } catch (err) {
    // An unauthenticated call or a malformed body was previously an unhandled
    // throw → Next's generic 500 HTML, which the client's `api()` helper could
    // not parse. It now returns the standard JSON error envelope.
    return toErrorResponse(err);
  }
}
