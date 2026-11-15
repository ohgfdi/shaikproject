import Link from "next/link";

import { LazyAmbientScene } from "@/components/scene/lazy-scenes";
import { Logo } from "@/components/ui/primitives";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Shared ambient 3D set behind the card. Self-gating: renders nothing
          on flat tiers or for reduced-motion users. */}
      <LazyAmbientScene className="pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="Ledgerly home" className="mb-6 flex justify-center">
          <Logo />
        </Link>
        <section className="card mat-panel p-6">
          <h1 className="text-h2 text-foreground">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </section>
        {footer && <div className="mt-4 text-center text-caption text-muted">{footer}</div>}
      </div>
    </main>
  );
}
