"use client";

import { useState } from "react";

/**
 * Client sign-in. The email is checked against the accounts the firm invited;
 * the response never says whether the address exists.
 */
export function PortalLogin(props: {
  token: string;
  engagementName: string | null;
  signedInEmail: string | null;
  error: string | null;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    try {
      const response = await fetch(`/api/portal/${encodeURIComponent(props.token)}/login/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setState(response.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Client sign-in</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          {props.engagementName
            ? `Sign in for ${props.engagementName}.`
            : "This portal link is invalid or has expired. Ask your CA firm for a new one."}
        </p>
      </div>

      {props.error === "invalid" && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          That sign-in link is invalid or has expired. Request a new one below.
        </p>
      )}

      {props.signedInEmail ? (
        <p className="rounded-md border border-neutral-300 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">
          Signed in as <strong>{props.signedInEmail}</strong>.{" "}
          <a className="underline" href={`/portal/${encodeURIComponent(props.token)}`}>
            Return to the portal
          </a>
          .
        </p>
      ) : state === "sent" ? (
        <p role="status" className="rounded-md border border-neutral-300 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-200">
          If that address is invited to this portal, a sign-in link is on its way. It expires in 15
          minutes and can be used once.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="portal-email" className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            Your email
          </label>
          <input
            id="portal-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm text-neutral-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-neutral-700 dark:text-neutral-100"
            placeholder="you@company.com"
          />
          <button
            type="submit"
            disabled={state === "sending"}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {state === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
          {state === "error" && (
            <p role="alert" className="text-sm text-red-700">
              The link could not be sent. Check your connection and try again, or ask your CA firm
              to re-send the invitation.
            </p>
          )}
          <p className="text-xs text-neutral-500">
            Signing in records your filing approvals against your name. The link alone still works
            for reading.
          </p>
        </form>
      )}

      <a className="text-sm underline" href={`/portal/${encodeURIComponent(props.token)}`}>
        Back to the portal
      </a>
    </main>
  );
}
