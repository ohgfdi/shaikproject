"use client";

import { Check, Copy, Lightbulb, Search, Share2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { type AnalysisTemplate, type TemplateSlot } from "@/lib/engine/template-catalog";
import {
  CATEGORY_RULES,
  formatVersion,
  marketplaceEntries,
  shareLink,
  type CategoryId,
} from "@/lib/engine/template-marketplace";

/* ------------------------------------------------------------------ */
/* Slot filling — the fill-in form for one template                    */
/* ------------------------------------------------------------------ */

function SlotPicker({
  slot,
  value,
  columns,
  onChange,
}: {
  slot: TemplateSlot;
  value: string;
  columns: string[];
  onChange: (v: string) => void;
}) {
  // If the user typed a column list (or the template is standalone), offer a
  // datalist; otherwise a plain input. The datalist is best-effort: no
  // workspace round-trip here, the client page stays static and indexable.
  const id = `slot-${slot.key}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-36 shrink-0 text-xs font-medium text-muted">
        {slot.label}
      </label>
      <input
        id={id}
        list={`${id}-options`}
        value={value}
        placeholder={slot.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-line bg-background px-2 text-xs text-foreground placeholder:text-muted/60 focus:border-accent focus:outline-none"
      />
      <datalist id={`${id}-options`}>
        {columns.map((c) => (
          <option key={c} value={`[${c}]`} />
        ))}
      </datalist>
    </div>
  );
}

function TemplateCard({
  template,
  version,
}: {
  template: AnalysisTemplate;
  version: { major: number; minor: number; patch: number };
}) {
  const [open, setOpen] = useState(false);
  const [slotValues, setSlotValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  const fill = (content: string) => {
    let out = content;
    for (const slot of template.slots) {
      const v = slotValues[slot.key]?.trim();
      if (v) out = out.split(slot.placeholder).join(v);
    }
    return out;
  };

  const copy = async (key: string, content: string) => {
    try {
      await navigator.clipboard.writeText(fill(content));
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard unavailable — leave the Copy label as-is.
    }
  };

  // Marketplace share: copies the versioned deep link for this template.
  const share = async () => {
    const link = `${window.location.origin}${shareLink(template.id, version)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: template.title, url: link });
      } else {
        await navigator.clipboard.writeText(link);
      }
      setShared(true);
      window.setTimeout(() => setShared(false), 1500);
    } catch {
      /* user cancelled the share sheet — nothing to do */
    }
  };

  const filled = template.slots.every((s) => (slotValues[s.key] ?? "").trim() !== "");

  return (
    <Card className="flex flex-col p-5 transition-colors hover:bg-surface-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{template.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">{template.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="badge bg-accent/12 text-accent-strong">{template.pack.toUpperCase()}</span>
          <span className="text-caption text-muted">v{formatVersion(version)}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-caption text-muted">
        <span className="rounded bg-surface-2 px-1.5 py-0.5">{template.level}</span>
        <span>·</span>
        <span>
          {template.steps.length} step{template.steps.length === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>→ {template.artifact.kind}</span>
      </div>

      {!open ? (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Open template
          </Button>
          {/* Internal link to the indexable landing page for this template.
              The landing pages in app/templates/[id] exist to be found by
              search, and they were orphaned: nothing in the app linked to them,
              so they had no internal inbound links at all. */}
          <ButtonLink href={`/templates/${template.id}`} variant="ghost" size="sm">
            Guide
          </ButtonLink>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void share()}
            icon={shared ? <Check aria-hidden className="size-3.5" /> : <Share2 aria-hidden className="size-3.5" />}
            aria-label={`Share ${template.title}`}
          >
            {shared ? "Link copied" : "Share"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-3 border-t border-line pt-3">
          {template.slots.length > 0 && (
            <div className="space-y-2 rounded-md border border-line bg-background p-3">
              <p className="text-xs font-medium text-foreground">
                Map your columns {filled ? "" : "(fill at least the ones you need)"}
              </p>
              {template.slots.map((slot) => (
                <SlotPicker
                  key={slot.key}
                  slot={slot}
                  value={slotValues[slot.key] ?? ""}
                  columns={[]}
                  onChange={(v) => setSlotValues((prev) => ({ ...prev, [slot.key]: v }))}
                />
              ))}
            </div>
          )}

          <ol className="space-y-2">
            {template.steps.map((step, i) => (
              <li key={i} className="rounded-md border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    <span className="badge mr-1.5 bg-surface-2 text-muted">{step.surface.toUpperCase()}</span>
                    {step.produces}
                  </p>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={
                      copied === `${template.id}-${i}` ? (
                        <Check aria-hidden className="size-3.5" />
                      ) : (
                        <Copy aria-hidden className="size-3.5" />
                      )
                    }
                    onClick={() => void copy(`${template.id}-${i}`, step.content)}
                    className={copied === `${template.id}-${i}` ? "text-accent" : ""}
                  >
                    {copied === `${template.id}-${i}` ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {fill(step.content)}
                </pre>
              </li>
            ))}
          </ol>

          <p className="text-caption text-muted">→ {template.artifact.note}</p>

          {/* Second inbound link from the expanded state — the landing page is
              the shareable, indexable version of exactly these steps. */}
          <Link
            href={`/templates/${template.id}`}
            className="mt-2 inline-block text-xs text-accent underline underline-offset-2"
          >
            Step-by-step guide
          </Link>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const DSL_QUICK_COMMANDS = [
  {
    id: "kpi-single",
    title: "KPI Summary",
    description: "Total, average, min, max of a numeric column",
    command: "%kpi column_name",
  },
  {
    id: "correlation",
    title: "Correlation",
    description: "Pearson correlation between two numeric columns",
    command: "%corr col1 col2",
  },
  {
    id: "trend-over-time",
    title: "Trend Over Time",
    description: "A metric over time using a date column",
    command: "%trend date_column",
  },
  {
    id: "histogram",
    title: "Distribution Histogram",
    description: "Distribution of a numeric column",
    command: "%histogram column_name",
  },
  {
    id: "top-values",
    title: "Top N Values",
    description: "Top N values of a numeric column",
    command: "%top 10 column_name",
  },
  {
    id: "unique-count",
    title: "Unique Value Count",
    description: "Count unique values in a column",
    command: "%unique column_name",
  },
];

function DslCard({ template }: { template: (typeof DSL_QUICK_COMMANDS)[number] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(template.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <Card className="flex flex-col p-4 transition-colors hover:bg-surface-2">
      <h3 className="text-sm font-medium text-foreground">{template.title}</h3>
      <p className="mt-1 grow text-xs text-muted">{template.description}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <code className="select-none truncate rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground">
          {template.command}
        </code>
        <Button
          variant="secondary"
          size="xs"
          icon={copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
          onClick={() => void copy()}
          className={copied ? "text-accent" : ""}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </Card>
  );
}

export default function TemplateGallery() {
  const [category, setCategory] = useState<CategoryId>("all");
  const [query, setQuery] = useState("");

  // Marketplace entries carry the version + category derivation per template.
  const entries = useMemo(() => marketplaceEntries(), []);

  const filtered = useMemo(() => {
    const rule = CATEGORY_RULES.find((c) => c.id === category) ?? CATEGORY_RULES[0]!;
    const base = entries.filter((e) => rule.matches(e.template));
    const q = query.trim().toLowerCase();
    const matched = q
      ? base.filter(
          (e) =>
            e.template.title.toLowerCase().includes(q) ||
            e.template.description.toLowerCase().includes(q) ||
            e.template.keywords.some((k) => k.toLowerCase().includes(q)),
        )
      : base;
    const levelOrder = { starter: 0, working: 1, advanced: 2 } as const;
    return [...matched].sort(
      (a, b) =>
        levelOrder[a.template.level] - levelOrder[b.template.level] || a.template.title.localeCompare(b.template.title),
    );
  }, [entries, category, query]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-h2 text-foreground">
          <Lightbulb aria-hidden className="size-6 text-accent" />
          Analysis templates
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Complete, runnable recipes for the work CA firms and consultants do every week — GST reconciliation, Tally
          trial balances, bank-statement cash flows, audit sampling screens. Map your columns, copy the steps, run them
          in the SQL Lab or notebook, and build the artifact from the same numbers.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {CATEGORY_RULES.map((c) => (
          <Button
            key={c.id}
            variant={category === c.id ? "primary" : "secondary"}
            size="sm"
            onClick={() => setCategory(c.id)}
            title={c.description}
          >
            {c.label}
          </Button>
        ))}
        <div className="relative ml-auto">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="h-8 w-52 rounded-md border border-line bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted/60 focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((e) => (
            <TemplateCard key={e.template.id} template={e.template} version={e.version} />
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm text-muted">No templates match that search. Try a pack filter or a shorter query.</p>
        </Card>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-foreground">Notebook quick commands</h2>
        <p className="mt-1 text-xs text-muted">
          One-liners for the notebook DSL kernel.{" "}
          <Link href="/notebooks" className="text-accent underline underline-offset-2">
            Open a notebook
          </Link>{" "}
          to run them.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DSL_QUICK_COMMANDS.map((t) => (
            <DslCard key={t.id} template={t} />
          ))}
        </div>
      </section>
    </main>
  );
}
