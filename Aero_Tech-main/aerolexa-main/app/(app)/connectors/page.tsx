import { PageHeader } from "@/components/layout/page-header";
import { ConnectorsPanel } from "@/components/settings/connectors-panel";
import { requirePageAuth } from "@/lib/auth/guard";
import { featureFlags } from "@/lib/server/features";

export const metadata = { title: "Data Connectors" };

export default async function ConnectorsPage() {
  // This page renders workspace connector configuration and was the one
  // authenticated surface with no page-level guard at all — it relied purely
  // on middleware, which (until 3.3) never matched /connectors. Guard here too
  // so the shell cannot render for an anonymous visitor.
  const ctx = await requirePageAuth();
  const flags = featureFlags({ isAdmin: ctx.user.isAdmin });

  return (
    <div>
      <PageHeader
        title="Data Connectors"
        description="Configure read-only external data sources. Connection strings are never sent to the client; all queries execute server-side."
      />
      <div className="mt-6">
        <ConnectorsPanel connectors={flags.connectors} />
      </div>
    </div>
  );
}
