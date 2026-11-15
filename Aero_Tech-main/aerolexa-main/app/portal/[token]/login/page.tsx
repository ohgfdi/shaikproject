import { PortalLogin } from "@/components/portal/portal-login";
import { resolvePortalToken } from "@/lib/server/client-portal";
import { readPortalSession } from "@/lib/server/portal-auth";

export const metadata = {
  title: "Client sign-in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Public sign-in page. The link still identifies the engagement. */
export default async function PortalLoginPage(props: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await props.params;
  const { error } = await props.searchParams;

  let engagementName: string | null = null;
  try {
    const ctx = await resolvePortalToken(token);
    engagementName = ctx.engagement.name;
  } catch {
    engagementName = null;
  }
  const session = await readPortalSession();

  return (
    <PortalLogin
      token={token}
      engagementName={engagementName}
      signedInEmail={session?.email ?? null}
      error={error ?? null}
    />
  );
}
