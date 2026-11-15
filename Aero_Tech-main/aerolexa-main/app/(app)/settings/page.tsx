import { cookies } from "next/headers";

import { FeedbackButton } from "@/components/feedback-button";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsPage, type SettingsTab } from "@/components/settings/settings-page";
import { requirePageAuth } from "@/lib/auth/guard";
import { BRAND_STORAGE_KEYS, readBrandCookie } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { featureFlags } from "@/lib/server/features";
import { parseAccent, parseTheme, type AccentName, type ThemeName } from "@/lib/theme";
import { GOAL_OPTIONS } from "@/lib/types";

export const metadata = { title: "Settings" };

const VALID_TABS: SettingsTab[] = [
  "profile",
  "workspace",
  "organization",
  "security",
  "api-keys",
  "notifications",
  "appearance",
  "data",
  "ai",
  "scheduled",
  "prompts",
  "sources",
  "audit",
];

export default async function SettingsRoute(props: { searchParams: Promise<{ tab?: string }> }) {
  const searchParams = await props.searchParams;
  const ctx = await requirePageAuth();
  const store = await cookies();
  const theme: ThemeName = parseTheme(readBrandCookie<string>(store, BRAND_STORAGE_KEYS.theme)?.value);
  const accent: AccentName = parseAccent(readBrandCookie<string>(store, BRAND_STORAGE_KEYS.accent)?.value);

  const requested = (searchParams.tab ?? "profile") as SettingsTab;
  const initialTab: SettingsTab = VALID_TABS.includes(requested) ? requested : "profile";

  const rawGoals = parseJson<unknown>(ctx.user.goals, []);
  const goals = Array.isArray(rawGoals)
    ? rawGoals.filter((g): g is string => typeof g === "string" && GOAL_OPTIONS.some((o) => o.value === g))
    : [];

  const flags = featureFlags({ isAdmin: ctx.user.isAdmin })
  const reports = await prisma.report.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    include: { project: { select: { name: true } } },
    take: 100,
  });

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your account, workspace, display and data preferences."
        actions={<FeedbackButton />}
      />
      <SettingsPage
        initialTab={initialTab}
        user={{
          id: ctx.user.id,
          name: ctx.user.name,
          email: ctx.user.email,
          profileRole: ctx.user.profileRole,
          organization: ctx.user.organization,
          industry: ctx.user.industry,
          experience: ctx.user.experience,
          goals,
          createdAt: ctx.user.createdAt.toISOString(),
          emailVerified: !!ctx.user.emailVerifiedAt,
          isAdmin: ctx.user.isAdmin,
        }}
        workspaceName={ctx.workspace.name}
        workspaceId={ctx.workspace.id}
        settings={ctx.settings}
        theme={theme}
        accent={accent}
        featureFlags={flags}
        reports={reports.map((r) => ({ id: r.id, title: r.title, projectName: r.project?.name ?? null }))}
      />
    </div>
  );
}
