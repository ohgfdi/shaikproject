import { ArrowRight, Lightbulb } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { ANALYSIS_TEMPLATES, type AnalysisTemplate } from "@/lib/engine/template-catalog";
import { templateJsonLd } from "@/lib/engine/template-jsonld";
import { appUrl } from "@/lib/env";

/**
 * Per-template landing pages — the search-indexing surface for the vertical
 * keywords. Each template gets a real, fully rendered page: the problem it
 * solves, the exact steps (SQL/DAX/DSL) with slot placeholders shown, and the
 * artifact it produces. Statically generated from the catalog; an unknown id
 * 404s. The steps deliberately render with placeholders ([Amount] etc.) —
 * honest about what runs where, while the in-app /templates gallery is the
 * interactive fill-and-copy surface.
 */

export function generateStaticParams(): { id: string }[] {
  return ANALYSIS_TEMPLATES.map((t) => ({ id: t.id }));
}

export async function generateMetadata(props: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await props.params;
  const template = ANALYSIS_TEMPLATES.find((t) => t.id === id);
  if (!template) return { title: "Template not found" };
  return {
    title: template.title,
    description: template.description,
    keywords: template.keywords,
    alternates: { canonical: `/templates/${template.id}` },
    openGraph: {
      title: `${template.title} · Ledgerly`,
      description: template.description,
      url: `${appUrl()}/templates/${template.id}`,
      type: "article",
    },
  };
}

const LEVEL_LABEL: Record<AnalysisTemplate["level"], string> = {
  starter: "Starter — first run in under 10 minutes",
  working: "Working level — for the weekly routine",
  advanced: "Advanced — audit-grade screens",
};

export default async function TemplateLandingPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const template = ANALYSIS_TEMPLATES.find((t) => t.id === id);
  if (!template) notFound();

  const related = ANALYSIS_TEMPLATES.filter((t) => t.pack === template.pack && t.id !== template.id).slice(0, 3);

  // HowTo structured data — the exact steps a searcher would run, in order.
  // Built by the shared helper so the bytes hashed into the CSP (this page is
  // static, so it cannot get a per-request nonce) always match what is emitted.
  const howTo = templateJsonLd(template);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <script
        type="application/ld+json"
        // Static catalog content — no user input reaches this JSON. The `<`
        // escape (inside templateJsonLd) makes that guarantee structural.
        dangerouslySetInnerHTML={{ __html: howTo }}
      />

      <nav aria-label="Breadcrumb" className="mb-6 text-caption text-muted">
        <Link href="/" className="hover:text-foreground">
          Ledgerly
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <Link href="/templates" className="hover:text-foreground">
          Templates
        </Link>
        <span aria-hidden className="mx-1.5">
          /
        </span>
        <span className="text-foreground">{template.title}</span>
      </nav>

      <div className="flex items-center gap-2">
        <span className="badge bg-accent/12 text-accent-strong">{template.pack.toUpperCase()}</span>
        <span className="badge bg-surface-2 text-muted">{LEVEL_LABEL[template.level]}</span>
      </div>

      <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">{template.title}</h1>
      <p className="mt-4 text-lg leading-relaxed text-muted">{template.description}</p>

      <div className="mt-6 flex flex-wrap gap-3">
        <ButtonLink href="/signup" size="lg" icon={<ArrowRight aria-hidden className="size-4" />}>
          Run this on your data — free
        </ButtonLink>
        <ButtonLink href="/templates" variant="secondary" size="lg">
          Browse all templates
        </ButtonLink>
      </div>

      {/* What you need */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold text-foreground">What you need</h2>
        <p className="mt-2 text-sm text-muted">
          Upload a CSV or Excel file containing these columns (your own headers — you map them in the app):
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {template.slots.map((slot) => (
            <li key={slot.key} className="rounded-lg border border-line bg-surface p-3">
              <p className="text-sm font-medium text-foreground">{slot.label}</p>
              <p className="mt-0.5 text-caption text-muted">
                {slot.hint} · <code className="font-mono text-[11px]">{slot.placeholder}</code>
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* The steps */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold text-foreground">The steps</h2>
        <p className="mt-2 text-sm text-muted">
          Every step runs inside Ledgerly — SQL on the DuckDB engine, measures with real DAX filter-context semantics,
          quick commands in the notebook. All read-only; your data never leaves your workspace.
        </p>
        <ol className="mt-6 space-y-4">
          {template.steps.map((step, i) => (
            <li key={i} className="rounded-lg border border-line bg-surface p-5">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/12 text-xs font-bold text-accent-strong">
                  {i + 1}
                </span>
                <span className="badge bg-surface-2 text-muted">{step.surface.toUpperCase()}</span>
                {step.produces}
              </p>
              <pre className="mt-3 overflow-x-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
                {step.content}
              </pre>
            </li>
          ))}
        </ol>
      </section>

      {/* The artifact */}
      <section className="mt-12">
        <h2 className="text-2xl font-bold text-foreground">The deliverable</h2>
        <Card className="mt-4 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Lightbulb aria-hidden className="size-4 text-accent" />
            Build a {template.artifact.kind}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">{template.artifact.note}</p>
        </Card>
      </section>

      {/* Honesty section */}
      <section className="mt-12 rounded-lg border border-accent/30 bg-surface p-6">
        <h2 className="text-lg font-bold text-foreground">Every number is computed, not invented</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Ledgerly&apos;s statistics engine is validated against SciPy/NumPy oracles in CI, and every result carries its
          provenance label. Nothing in this template calls a black-box API — the SQL, DAX and notebook commands above
          are exactly what runs against your uploaded file.
        </p>
      </section>

      {/* Related templates */}
      {related.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xl font-bold text-foreground">More {template.pack.toUpperCase()} templates</h2>
          <ul className="mt-4 grid gap-3">
            {related.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/templates/${t.id}`}
                  className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent/40"
                >
                  <p className="text-sm font-semibold text-foreground">{t.title}</p>
                  <p className="mt-1 line-clamp-2 text-caption text-muted">{t.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-12 border-t border-line pt-8">
        <ButtonLink href="/signup" size="lg" icon={<ArrowRight aria-hidden className="size-4" />}>
          Start free — upload your file
        </ButtonLink>
        <p className="mt-3 text-caption text-muted">No credit card. Your data stays in your workspace.</p>
      </div>
    </main>
  );
}
