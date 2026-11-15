import { WifiOff } from "lucide-react";
import Link from "next/link";

export const metadata = {
  title: "Offline · Ledgerly",
};

/**
 * Offline fallback (Band 3.4). Served by the service worker when a navigation
 * fails. It deliberately shows NO cached numbers — analytics must be computed
 * server-side from your data, and offline there is no honest way to show them.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="card max-w-md p-8">
        <WifiOff aria-hidden className="mx-auto size-10 text-accent" />
        <h1 className="mt-4 text-h2 text-foreground">You&apos;re offline</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Ledgerly keeps the app shell available, but every number on this workspace is computed from your data on the
          server — so analyses, dashboards and reports need a connection. Nothing was faked while you wait.
        </p>
        <p className="mt-3 text-caption text-muted">
          The app reconnects automatically. Once you&apos;re back online, reload to continue.
        </p>
        <Link
          href="/dashboard"
          className="mt-5 inline-block rounded-md border border-accent/60 bg-accent/10 px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/20"
        >
          Try again
        </Link>
      </div>
    </main>
  );
}
