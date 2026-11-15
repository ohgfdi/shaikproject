import { ClientPortal } from "@/components/portal/client-portal";

export const metadata = {
  title: "Client portal",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Public client portal, reached only through a hashed, expiring link. It sits
 * outside `(app)` on purpose: no firm shell, no navigation into the practice,
 * no session. Everything it can see comes from `/api/portal/[token]`.
 */
export default async function ClientPortalPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  return (
    <div>
      <div className="flex justify-end px-4 pt-3 text-sm">
        <a className="underline" href={`/portal/${encodeURIComponent(token)}/login`}>
          Client sign-in
        </a>
      </div>
      <ClientPortal token={token} />
    </div>
  );
}
