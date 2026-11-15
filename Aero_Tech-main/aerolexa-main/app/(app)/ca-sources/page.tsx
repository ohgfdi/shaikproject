import { CaSourcesWorkspace } from "@/components/ca/ca-sources-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { requirePageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { CA_SOURCE_KINDS } from "@/lib/engine/ca-source";
import { listCaSources } from "@/lib/server/ca-source";

export const metadata = { title: "CA Sources" };

/**
 * CA source ingestion: turn a client's source systems (Tally vouchers, bank
 * statements, GST invoices, TDS challans, payroll exports…) into a canonical,
 * fingerprint-deduped document set with a full source-to-figure trace, using a
 * mapping profile saved once per source and reused on every repeat sync.
 */
export default async function CaSourcesPage() {
  const ctx = await requirePageAuth();
  const sources = await listCaSources(ctx);
  const engagements = ctx.organization
    ? await prisma.engagement.findMany({
        where: { organizationId: ctx.organization.id },
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
        take: 200,
      })
    : [];

  return (
    <div>
      <PageHeader
        title="CA Sources"
        description="Ingest a client's source systems into a canonical, traceable document set. Save a mapping profile once — “column X means canonical field Y” — and reuse it on every repeat sync, deduping by identity rather than row index."
      />
      <div className="mt-6">
        <CaSourcesWorkspace initialSources={sources} kinds={CA_SOURCE_KINDS} engagements={engagements} />
      </div>
    </div>
  );
}
