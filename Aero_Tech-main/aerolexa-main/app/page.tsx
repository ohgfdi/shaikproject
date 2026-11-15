import {
  ArrowRight,
  BarChart3,
  Briefcase,
  Check,
  ChevronDown,
  Database,
  FileCode2,
  FileText,
  Gauge,
  LayoutDashboard,
  Lightbulb,
  Lock,
  Plug,
  Presentation,
  Send,
  ShieldCheck,
  Sparkles,
  Table2,
  Upload,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { HeroPreview } from "@/components/marketing/hero-3d";
import { FOOTER_LINKS, NAV_LINKS } from "@/components/marketing/links";
import { MobileNav } from "@/components/marketing/mobile-nav";
import { LazyHeroBackdrop } from "@/components/scene/lazy-scenes";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/ui/primitives";
import { Tilt } from "@/components/ui/tilt";
import { getAuth } from "@/lib/auth/guard";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Shared section shell                                                */
/* ------------------------------------------------------------------ */

function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-24 border-t border-line", className)}>
      <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">{children}</div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  sub,
  align = "center",
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  align?: "center" | "left";
}) {
  return (
    <div className={cn("max-w-2xl", align === "center" ? "mx-auto text-center" : "")}>
      {eyebrow && (
        <p className="mb-3 text-caption font-semibold uppercase tracking-widest text-accent-strong dark:text-[#7FC6C8]">
          {eyebrow}
        </p>
      )}
      <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{title}</h2>
      {sub && <p className="mt-4 text-base text-muted sm:text-lg">{sub}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="Ledgerly home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="ml-auto hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:ml-4">
          <ButtonLink href="/login" variant="ghost" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href="/signup" icon={<ArrowRight aria-hidden className="size-4" />} className="px-4">
            Get started
          </ButtonLink>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function ProductPreview() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-background shadow-pop">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <div className="flex gap-1.5">
          <div className="size-3 rounded-full bg-red-500/80" />
          <div className="size-3 rounded-full bg-yellow-500/80" />
          <div className="size-3 rounded-full bg-green-500/80" />
        </div>
        <span className="text-xs text-muted">app.aerolexa.io — Notebook</span>
      </div>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
        <p className="text-sm font-medium text-muted">Ledgerly · Deterministic notebook</p>
        <div className="mt-4 flex items-center gap-2 text-left">
          <span className="badge bg-accent/15 text-accent-strong">Prototype / Demo</span>
          <span className="text-caption text-muted">Kernel: Pyodide (browser)</span>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3 text-center sm:grid-cols-3">
          <div className="rounded-lg border border-line bg-surface/70 p-3">
            <p className="text-2xl font-bold text-foreground">12,847</p>
            <p className="text-caption text-muted">Rows loaded</p>
          </div>
          <div className="rounded-lg border border-line bg-surface/70 p-3">
            <p className="text-2xl font-bold text-foreground">98.7%</p>
            <p className="text-caption text-muted">Data quality</p>
          </div>
          <div className="rounded-lg border border-line bg-surface/70 p-3">
            <p className="text-2xl font-bold text-foreground">0.4s</p>
            <p className="text-caption text-muted">Query time</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative min-h-[700px] overflow-hidden bg-background">
      {/* Abstract data grid background */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(to_bottom_right,rgb(var(--line)/0.03),transparent_0.5),linear-gradient(to_bottom,rgb(var(--line)/0.02),transparent_0.5)] bg-[length:60px_60px]"
      />
      {/* Stylized 3D data skyline */}
      <LazyHeroBackdrop />

      <div className="relative mx-auto w-full max-w-7xl px-4 pb-8 pt-16 sm:px-6 sm:pt-24 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-caption font-medium text-muted transition-colors hover:text-foreground">
            <Sparkles aria-hidden className="size-3.5 text-accent-strong dark:text-[#7FC6C8]" />
            Deterministic by design
          </div>

          <h1 className="mt-8 text-5xl font-extrabold leading-[1.1] tracking-tight text-foreground sm:text-6xl lg:text-8xl">
            From raw data to{" "}
            <span className="bg-gradient-to-r from-accent-strong via-accent to-amber bg-clip-text text-transparent dark:from-[#7FC6C8] dark:via-accent dark:to-amber">
              boardroom decisions
            </span>
          </h1>

          <p className="mt-8 mx-auto max-w-2xl text-lg text-muted sm:text-xl leading-relaxed">
            Upload a CSV or Excel file and Ledgerly profiles it instantly. Every analysis, insight, dashboard, and
            presentation downstream runs against that exact dataset — no samples, no invented numbers, full
            transparency. Unlike notebook tools that lock you into sample workflows, Ledgerly gives you board-ready
            artifacts (reports, presentations) from the same numbers — with explicit provenance labels. Run Python, SQL,
            or DuckDB-wasm in your browser. Self-host or use our cloud.
          </p>

          <div className="mt-10 mx-auto flex max-w-xl flex-col sm:flex-row gap-3 sm:items-center">
            <ButtonLink href="/signup" size="lg" icon={<ArrowRight aria-hidden className="size-4" />}>
              Start free — upload your first file
            </ButtonLink>
            <ButtonLink href="#how" variant="secondary" size="lg">
              See how it works
            </ButtonLink>
          </div>

          <p className="mt-6 text-caption text-muted">Free to start · No credit card · Your data stays yours</p>
        </div>

        <HeroPreview>
          <ProductPreview />
        </HeroPreview>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tech stack strip                                                    */
/* ------------------------------------------------------------------ */

const TECH_CHIPS = [
  "CSV",
  "XLSX",
  "DuckDB",
  "SQL",
  "Python · Pyodide",
  "PostgreSQL",
  "Snowflake",
  "BigQuery",
  "No-code DSL",
  "Scheduled sync",
  ".ipynb export",
  "Self-hostable",
];

function TechStrip() {
  const chips = [...TECH_CHIPS, ...TECH_CHIPS];
  return (
    <section className="border-t border-line py-12">
      <p className="mb-6 text-center text-caption font-semibold uppercase tracking-widest text-muted">
        Works with the data you already have
      </p>
      <div
        aria-hidden
        className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
      >
        <div className="flex w-max animate-marquee items-center gap-3">
          {chips.map((chip, i) => (
            <span
              key={`${chip}-${i}`}
              className="whitespace-nowrap rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-medium text-muted"
            >
              {chip}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

const OLD_WAY = [
  "Weeks of setup, pipelines and connector plumbing",
  "Sample data while you wait for the real thing",
  "Black-box models you can't audit or explain",
  "Context-switching across six different tools",
  "Charts and numbers that don't survive a slide deck",
  "A licence cost for every person who touches data",
  "Your data lives in someone else's cloud by default",
];

const aerolexa_WAY = [
  "Upload in seconds — profiling and quality checks included",
  "Deterministic engines with visible methodology — every result labelled",
  "Insight cards with evidence, causes and next steps",
  "One workspace: notebook, SQL, dashboards, reports AND presentations",
  "Board-ready presentations from the same numbers — PDF/HTML export included",
  "Prototype logic labelled, Python export to verify anything — no black boxes",
  "Self-hostable with SQLite or PostgreSQL — your data, your infra",
];

function Comparison() {
  return (
    <Section id="product">
      <SectionHeading
        eyebrow="Why Ledgerly"
        title="The old way vs. the Ledgerly way"
        sub="Most analytics stacks are built for the tool, not for the answer. Ledgerly starts from your file and ends at a decision."
      />
      <div className="mx-auto mt-12 grid max-w-5xl gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-6">
          <p className="mb-4 text-caption font-semibold uppercase tracking-widest text-muted">The old way</p>
          <ul className="space-y-3">
            {OLD_WAY.map((item, _i) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-muted">
                <X aria-hidden className="mt-0.5 size-4 shrink-0 text-danger/80" />
                <span className="font-medium text-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-6">
          <p className="mb-4 text-caption font-semibold uppercase tracking-widest text-accent-strong dark:text-[#7FC6C8]">
            The Ledgerly way
          </p>
          <ul className="space-y-3">
            {aerolexa_WAY.map((item, _i) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-foreground">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                <span className="font-medium text-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

const FEATURES = [
  {
    icon: BarChart3,
    title: "Analysis Lab",
    body: "Profiling, EDA, KPIs, trends, correlations, forecasts, segmentation, cohorts and funnels — every technique ships with its methodology shown. Run anywhere: browser (DuckDB-wasm/Pyodide) or server.",
  },
  {
    icon: Lightbulb,
    title: "Insight Engine",
    body: "Severity-ranked insight cards with evidence, likely causes and recommended next steps. Ask the data, not the dashboard — every card cites its computed evidence.",
  },
  {
    icon: FileCode2,
    title: "Notebook",
    body: "Python via Pyodide running in your browser, or a DSL whose statistics are SciPy-oracle-validated. Export notebooks as runnable .ipynb or Python scripts — verified against your exact data.",
  },
  {
    icon: Database,
    title: "SQL Lab",
    body: "DuckDB in the browser or on the server, with a prototype fallback so your queries never dead-end. Results labelled with engine origin — browser or server.",
  },
  {
    icon: LayoutDashboard,
    title: "Dashboards",
    body: "A drag-and-drop builder with KPI cards, cross-filtering and custom charts. Publish, embed and present live — or export as part of a report. Board-ready from the same numbers.",
  },
  {
    icon: Presentation,
    title: "Reports & presentations",
    body: "Auto-assembled artifacts from the same numbers — HTML, Python and .ipynb exports, scheduled delivery. Everything traces back to your exact uploaded file. No data lock-in.",
  },
  {
    icon: Plug,
    title: "Data connectors",
    body: "PostgreSQL, Snowflake and BigQuery connectors with scheduled sync, plus CSV/XLSX upload for everything else. Self-hostable deployments available.",
  },
  {
    icon: ShieldCheck,
    title: "Transparency by default",
    body: "Deterministic in-repo engines, demo logic always labelled, and Python export so nothing is trapped in the product. Unlike Hex's live ML pipelines, Ledgerly always tells you when a number is prototype-grade.",
  },
];

function Features() {
  return (
    <Section>
      <SectionHeading
        eyebrow="Everything in one workspace"
        title="Eight tools. One dataset. Zero context-switching."
        sub="Ledgerly covers the whole arc — from a raw file to a decision — without moving data between products."
      />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f, _i) => (
          <Tilt
            key={f.title}
            max={7}
            className="group h-full rounded-lg border border-line bg-surface p-5 transition-colors hover:border-accent/40 hover:shadow-pop"
          >
            <div className="mb-3 inline-flex size-10 items-center justify-center rounded-md bg-accent/12 ring-1 ring-accent/25 transition-colors group-hover:bg-accent/20">
              <f.icon aria-hidden className="size-5 text-accent-strong dark:text-[#7FC6C8]" />
            </div>
            <h3 className="text-base font-semibold text-foreground">{f.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.body}</p>
          </Tilt>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

const STEPS = [
  {
    icon: Upload,
    step: "01",
    title: "Upload",
    body: "Drag & drop CSV or Excel. Ledgerly streams the file and profiles structure, types and data quality in seconds — surfaced as an honest quality report. Your data stays in your workspace.",
  },
  {
    icon: Workflow,
    step: "02",
    title: "Explore",
    body: "Run analyses, ask the Insight Engine, or open the Notebook and SQL Lab against the same dataset. Every result is reproducible and labelled. Run in-browser (DuckDB-wasm/Pyodide) or on your server.",
  },
  {
    icon: Send,
    step: "03",
    title: "Share",
    body: "Assemble dashboards, reports and presentations from the same numbers. Schedule delivery, export Python or .ipynb, present in the app. Self-hostable — your data never leaves your control.",
  },
];

function HowItWorks() {
  return (
    <Section id="how">
      <SectionHeading
        eyebrow="How it works"
        title="From file to decision in three steps"
        sub="No onboarding gauntlet, no sample dataset, no analyst ticket required."
      />
      <ol className="mx-auto mt-12 grid max-w-5xl gap-4 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.step} className="relative h-full [perspective:1200px]">
            <Tilt max={6} className="h-full rounded-lg border border-line bg-surface p-6">
              <span
                aria-hidden
                className="text-caption font-bold tracking-widest text-accent-strong dark:text-[#7FC6C8]"
              >
                {s.step}
              </span>
              <div className="mt-3 inline-flex size-10 items-center justify-center rounded-md bg-surface-2 ring-1 ring-line">
                <s.icon aria-hidden className="size-5 text-foreground" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-foreground">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </Tilt>
            {i < STEPS.length - 1 && (
              <ArrowRight
                aria-hidden
                className="absolute -right-4 top-1/2 hidden size-5 -translate-y-1/2 text-muted lg:block"
              />
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Use cases                                                           */
/* ------------------------------------------------------------------ */

const USE_CASES = [
  {
    icon: Briefcase,
    role: "For CA firms",
    title: "GST reconciliation in hours, not days",
    body: "Reconcile output tax against input credit by GSTIN and month, surface the suppliers whose invoices never landed, and hand clients a dashboard instead of a spreadsheet. Tally exports, bank statements and audit sampling screens ship as ready templates.",
  },
  {
    icon: Table2,
    role: "For data analysts",
    title: "Replace copy-paste EDA",
    body: "Profile, segment, forecast and document methodology in one workspace — then export the Python that produced it. Every number carries its provenance label.",
  },
  {
    icon: Gauge,
    role: "For consultants & advisors",
    title: "Client deliverables from the same numbers",
    body: "The analysis, the report and the board deck all read from one dataset — when the file updates, the story updates. Publish client-facing dashboards with a link, not a PDF chain.",
  },
  {
    icon: Lock,
    role: "Enterprise-grade security",
    title: "PostgreSQL-ready with RLS and audit exports",
    body: "Row-level security on engagements, projects, working papers and deliverables. Full audit export capability. Privacy controls cover every personal-data model including ClientPortalToken, ClientPortalUpload, ClientComplianceProfile and ClientComplianceStatus.",
  },
  {
    icon: Zap,
    role: "Phase 5.3 rate limiting",
    title: "Per-API-key rate limiting",
    body: "Optional keyId parameter enables per-API-key rate limiting (backward-compatible). 10/10 tests pass with both SQLite and PostgreSQL. Governed by a rate-limit ledger shared across replica bus rooms.",
  },
];

function UseCases() {
  return (
    <Section id="use-cases">
      <SectionHeading
        eyebrow="Use cases"
        title="Built for everyone who touches the numbers"
        sub="One workspace, three very different jobs — from deep analysis to the weekly meeting."
      />
      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {USE_CASES.map((uc) => (
          <Tilt
            key={uc.title}
            max={6}
            className="rounded-lg border border-line bg-surface p-6 transition-colors hover:border-accent/30"
          >
            <div className="mb-4 inline-flex size-10 items-center justify-center rounded-md bg-accent/12 ring-1 ring-accent/25">
              <uc.icon aria-hidden className="size-5 text-accent-strong dark:text-[#7FC6C8]" />
            </div>
            <p className="text-caption font-semibold uppercase tracking-widest text-muted">{uc.role}</p>
            <h3 className="mt-1 text-lg font-semibold text-foreground">{uc.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{uc.body}</p>
          </Tilt>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Transparency                                                        */
/* ------------------------------------------------------------------ */

const TRUST_POINTS = [
  {
    icon: ShieldCheck,
    title: "Oracle-validated engines",
    body: "Stats, insights, the advisor and the notebook DSL all run deterministic in-repo logic against your uploaded file — compared against SciPy/NumPy oracles in CI, not a black-box API.",
  },
  {
    icon: Zap,
    title: "Always labelled",
    body: "Every result carries its provenance — Calculated for the oracle-validated engines, Prototype / Demo wherever logic is still prototype-grade. Nothing pretends to be production-ready without earning it.",
  },
  {
    icon: Lock,
    title: "Compute close to you",
    body: "DuckDB-wasm and Pyodide run in your browser; the server engine offloads queries to a worker thread. Self-hostable with SQLite or PostgreSQL. Your data never leaves your control.",
  },
  {
    icon: FileText,
    title: "Export everything",
    body: "Python and .ipynb export for notebooks and analyses, HTML exports for reports — nothing is trapped in the product. Export the Python that actually produced the results and run it yourself.",
  },
  {
    icon: Users,
    title: "Multi-tenant friendly",
    body: "Organizations with role-based access (owner/admin/member/viewer). Audit logs track every action. SSO-ready for enterprise teams.",
  },
];

function Transparency() {
  return (
    <Section id="transparency">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="Trust"
            title="No fake data. No black boxes."
            sub="Ledgerly is honest by construction. Every number you see was computed from your file by logic you can inspect — and where it isn't production-grade, it tells you."
          />
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {TRUST_POINTS.map((t, _i) => (
              <Tilt
                key={t.title}
                max={5}
                className="rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent/25"
              >
                <div className="flex items-center gap-2">
                  <t.icon aria-hidden className="size-4 text-accent-strong dark:text-[#7FC6C8]" />
                  <h3 className="text-sm font-semibold text-foreground">{t.title}</h3>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{t.body}</p>
              </Tilt>
            ))}
          </div>
        </div>

        {/* Labelled-result visual */}
        <div aria-hidden className="relative">
          <div className="rounded-lg border border-line bg-surface p-5 shadow-pop">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-foreground">Insight #3 · Customer churn</p>
              <span className="badge bg-amber/15 text-amber">Prototype / Demo</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Churn among monthly plans rose 0.4 pp after the June price change — concentrated in the SMB segment.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-caption">
              <div className="rounded-md border border-line bg-surface-2/70 p-2.5">
                <p className="text-muted">Evidence</p>
                <p className="mt-0.5 font-medium text-foreground">2 cohorts - p less than 0.05</p>
              </div>
              <div className="rounded-md border border-line bg-surface-2/70 p-2.5">
                <p className="text-muted">Next step</p>
                <p className="mt-0.5 font-medium text-foreground">Review pricing comms</p>
              </div>
            </div>
            <div className="mt-4 border-t border-line pt-3 text-caption text-muted">
              Methodology: two-tailed cohort comparison · data:{" "}
              <strong className="font-medium text-foreground">your file</strong>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

const PLANS = [
  {
    name: "Free",
    price: "₹0",
    cadence: "forever",
    tagline: "Everything computed. Nothing distributed.",
    cta: { label: "Start free", href: "/signup" },
    features: [
      "Unlimited uploads, profiling & analyses",
      "Notebook (Python / DSL) + SQL Lab with DuckDB",
      "Reports, presentations & model training",
      "Exports: PDF/HTML, XLSX, .ipynb, Python",
      "1 workspace — every number fully computed",
    ],
  },
  {
    name: "Pro",
    price: "₹999",
    cadence: "per workspace / month",
    tagline: "For consultants who share work with clients.",
    highlight: true,
    cta: { label: "Start free trial", href: "/signup" },
    features: [
      "Everything in Free",
      "Public share links (dashboards, reports, apps)",
      "Scheduled reports & notebook publishing",
      "External connectors (Postgres, Snowflake, BigQuery) + sync",
      "API keys — build on your workspace programmatically",
      "Priority email support",
    ],
  },
  {
    name: "Firm",
    price: "₹4,999",
    cadence: "per firm / month",
    tagline: "For CA firms running engagements across a team.",
    cta: { label: "Start with Firm", href: "/signup" },
    features: [
      "Everything in Pro",
      "Unlimited team seats with org roles (ADMIN/MEMBER/AUDITOR)",
      "Engagements — one confidential silo per client",
      "Row-level security & audit exports",
      "SSO via any OIDC provider (Okta, Entra, Keycloak)",
      "Onboarding for your team",
    ],
  },
];

function Pricing() {
  return (
    <Section id="pricing">
      <SectionHeading
        eyebrow="Pricing"
        title="Start free. Upgrade when your work needs to travel."
        sub="Plans gate capacity and distribution — never computed results. A free workspace's numbers are exactly as computed as a Firm workspace's."
      />
      <div className="mx-auto mt-12 grid max-w-5xl gap-4 lg:grid-cols-3 [perspective:1600px]">
        {PLANS.map((plan) => (
          <Tilt
            key={plan.name}
            max={5}
            className={cn(
              "relative flex flex-col rounded-lg border bg-surface p-6 transition-colors",
              plan.highlight ? "border-accent/50 shadow-pop hover:border-accent" : "border-line hover:border-accent/30",
            )}
          >
            {plan.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-0.5 text-caption font-semibold text-on-accent">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
            <p className="mt-1 text-sm text-muted">{plan.tagline}</p>
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-extrabold tracking-tight text-foreground">{plan.price}</span>
              <span className="text-caption text-muted">{plan.cadence}</span>
            </p>
            <ul className="mt-6 flex-1 space-y-2.5">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href={plan.cta.href}
              className={cn(
                "mt-7 inline-flex h-11 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
                plan.highlight
                  ? "bg-accent text-on-accent hover:bg-accent-strong"
                  : "border border-line text-foreground hover:bg-surface-2",
              )}
            >
              {plan.cta.label}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Tilt>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* FAQ                                                                 */
/* ------------------------------------------------------------------ */

const FAQS = [
  {
    q: "Do you use sample or fake data?",
    a: "No. Ledgerly runs entirely on the file you upload — profiling, analyses, insights, dashboards and presentations all compute from your exact data. There is no hidden sample workspace.",
  },
  {
    q: "Is this a real ML pipeline?",
    a: "Not yet, and it never pretends to be. Every result is computed by deterministic in-repo logic, and anything prototype-grade carries an explicit Prototype / Demo badge. When live pipelines ship, the labels come off.",
  },
  {
    q: "Where does my data go?",
    a: "Your choice. In the browser build, DuckDB-wasm and Pyodide do the compute client-side. On the server, queries run on a worker thread and data lives in your deployment's database — SQLite locally, PostgreSQL in production. The app is self-hostable.",
  },
  {
    q: "Which databases can I connect to?",
    a: "PostgreSQL, Snowflake and BigQuery connectors are built in, with scheduled sync. Everything else — and everything in a hurry — starts as a CSV or XLSX upload into DuckDB.",
  },
  {
    q: "Can I export my work?",
    a: "Yes. Analyses and notebooks export as Python or .ipynb, reports as HTML, and charts as SVG. Nothing you produce is trapped inside the product.",
  },
  {
    q: "What exactly does the prototype label mean?",
    a: "It means the result was produced by deterministic prototype logic rather than a live production pipeline. It's a promise: the product will always tell you when a number is demo-grade.",
  },
];

function Faq() {
  return (
    <Section id="faq">
      <SectionHeading
        eyebrow="FAQ"
        title="Questions, answered honestly"
        sub="If it's not answered here, the answer is usually 'it's computed from your data'."
      />
      <div className="mx-auto mt-10 max-w-3xl space-y-2">
        {FAQS.map((faq) => (
          <details
            key={faq.q}
            className="group rounded-lg border border-line bg-surface transition-colors open:border-accent/40"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
              {faq.q}
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="px-5 pb-5 text-sm leading-relaxed text-muted">{faq.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Final CTA + footer                                                  */
/* ------------------------------------------------------------------ */

function FinalCta() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="relative overflow-hidden rounded-xl border border-accent/30 bg-surface px-6 py-16 text-center sm:px-12">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(var(--accent)/0.14),transparent_65%)]"
          />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              Your data has a story. See it in minutes.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted sm:text-lg">
              Sign up, upload your first file, and watch the same numbers flow from profiling to a board-ready
              presentation. Everything is deterministic, labelled, and exportable.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <ButtonLink href="/signup" size="lg" icon={<ArrowRight aria-hidden className="size-4" />}>
                Start free — upload your first file
              </ButtonLink>
              <ButtonLink href="/login" variant="secondary" size="lg">
                Sign in
              </ButtonLink>
            </div>
            <p className="mt-4 text-caption text-muted">
              Free to start · No credit card · Deterministic, labelled logic
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              A data-driven analytics workspace. Upload once, and every analysis, insight, dashboard and presentation
              runs against your exact data — with full transparency.
            </p>
            <p className="mt-4 inline-flex items-center gap-1.5 text-caption text-muted">
              <Users aria-hidden className="size-3.5" />
              Built for teams who refuse fake data
            </p>
          </div>
          {Object.entries(FOOTER_LINKS).map(([group, links]) => (
            <nav key={group} aria-label={group}>
              <p className="mb-3 text-caption font-semibold uppercase tracking-widest text-muted">{group}</p>
              <ul className="space-y-2">
                {links.map((link) => (
                  <li key={`${group}-${link.label}`}>
                    <a href={link.href} className="text-sm text-muted transition-colors hover:text-foreground">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 border-t border-line pt-6">
          <p className="text-center text-caption text-muted">
            © {new Date().getFullYear()} Ledgerly · Prototype — demo-mode logic is always labelled in the product. No
            live ML pipeline is claimed where none runs.
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default async function LandingPage() {
  const ctx = await getAuth();
  if (ctx) redirect("/dashboard");

  return (
    <main className="min-h-screen bg-background">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Header />
      <div id="main-content">
        <Hero />
        <TechStrip />
        <Comparison />
        <Features />
        <HowItWorks />
        <UseCases />
        <Transparency />
        <Pricing />
        <Faq />
        <FinalCta />
        <Footer />
      </div>
    </main>
  );
}
