import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { getAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/server/features";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuth();
  if (!ctx) redirect("/login");
  if (!ctx.user.onboardedAt) redirect("/onboarding");

  const unread = await prisma.notification.count({
    where: { userId: ctx.user.id, readAt: null },
  });

  /**
   * This prop was never passed, so AppShell defaulted `moduleFlags` to `{}` and
   * every FROZEN_NAV entry filtered out unconditionally — the nav looked
   * correctly narrowed while being completely indifferent to
   * LEDGERLY_PROFILE. Passing the real flags makes the funnel genuinely
   * profile-driven.
   */
  const flags = featureFlags({ isAdmin: ctx.user.isAdmin })

  /**
   * The shell consumes only the frozen-module booleans; pass them explicitly
   * (FeatureFlags itself also carries strings/arrays, which is why it cannot
   * satisfy the Partial<Record<string, boolean>> prop directly).
   */
  const moduleFlags = {
    notebookEnabled: flags.notebookEnabled,
    trainingEnabled: flags.trainingEnabled,
    advisorEnabled: flags.advisorEnabled,
    connectorsEnabled: flags.connectorsEnabled,
    schedulerEnabled: flags.schedulerEnabled,
    promptsEnabled: flags.promptsEnabled,
  };

  return (
    <AppShell
      user={{
        id: ctx.user.id,
        name: ctx.user.name,
        email: ctx.user.email,
        profileRole: ctx.user.profileRole,
      }}
      unread={unread}
      moduleFlags={moduleFlags}
    >
      {children}
    </AppShell>
  );
}
