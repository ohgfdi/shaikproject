import { readPortalSession } from "@/lib/server/portal-auth";

export const metadata = {
  title: "Signed in — client portal",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Landing page after a firm-invite sign-in. The work lives behind the link. */
export default async function PortalSignedInPage(props: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await props.searchParams;
  const session = await readPortalSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
        {error ? "That sign-in link is no longer valid" : "You are signed in"}
      </h1>
      {error ? (
        <p className="text-neutral-600 dark:text-neutral-300">
          Sign-in links expire after 15 minutes and work once. Ask your CA firm to send a new
          invitation, then open the link from the email again.
        </p>
      ) : session ? (
        <p className="text-neutral-600 dark:text-neutral-300">
          Signed in as <strong>{session.name ?? session.email}</strong>. Open the client portal link
          your CA firm sent you; approvals you make there are recorded against this account.
        </p>
      ) : (
        <p className="text-neutral-600 dark:text-neutral-300">
          Open the client portal link your CA firm sent you to continue.
        </p>
      )}
    </main>
  );
}
