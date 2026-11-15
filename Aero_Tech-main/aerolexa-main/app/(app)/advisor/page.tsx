import { notFound } from "next/navigation";

import { AdvisorPanel } from "@/components/advisor/advisor-panel";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { moduleEnabled } from "@/lib/server/modules";

export const metadata = { title: "Business Advisor" };

export default async function AdvisorPage() {
  const ctx = await requirePageAuth();
  // 404 rather than redirect: a frozen advisor must not leak the dataset list
  // it would have shown, and the nav entry that links here is already hidden.
  if (!moduleEnabled("ADVISOR_ENABLED")) notFound();
  const datasets = await prisma.dataset.findMany({
    where: { workspaceId: ctx.workspace.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { project: { select: { name: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Business Advisor"
        description="Ask questions in plain language. The advisor routes them over your uploaded data and returns a structured, confidence-flagged answer."
      />
      <AdvisorPanel
        datasets={datasets.map((d) => ({
          id: d.id,
          name: d.name,
          rowCount: d.rowCount,
          projectName: d.project?.name ?? null,
        }))}
      />
    </div>
  );
}
