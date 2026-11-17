import { BookMarked } from "lucide-react";
import { notFound } from "next/navigation";

import { ArtifactGrid } from "@/components/layout/artifact-grid";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { moduleEnabled } from "@/lib/server/modules";
import { withTenantDb } from "@/lib/server/tenant-db";

export const metadata = { title: "Prompt Library" };

export default async function PromptsPage() {
  const ctx = await requirePageAuth();
  // 404 rather than redirect: a frozen profile must not list the workspace's
  // prompt templates, and the nav entry that links here is already hidden.
  if (!moduleEnabled("PROMPTS_ENABLED")) notFound();
  const prompts = await prisma.prompt.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  return (
    <div>
      <PageHeader
        title="Prompt Library"
        description="Reusable prompt templates with detected variables, managed from Settings."
      />
      <div className="mt-6">
        <ArtifactGrid
          icon={BookMarked}
          emptyTitle="No prompts yet"
          emptyDescription="Create your first reusable prompt template from Settings → Prompt Library."
          createHref="/settings?tab=prompts"
          createLabel="Manage prompts"
          items={prompts.map((p) => ({
            id: p.id,
            title: p.name,
            sub: p.description,
            href: "/settings?tab=prompts",
            updatedAt: p.updatedAt,
          }))}
        />
      </div>
    </div>
  );
}
