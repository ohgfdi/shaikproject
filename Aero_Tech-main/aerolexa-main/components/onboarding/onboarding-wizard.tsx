"use client";

import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Briefcase,
  Check,
  FileSpreadsheet,
  Globe,
  Megaphone,
  Play,
  Rocket,
  Upload,
  UploadCloud,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useEffect } from "react";

import { LazyAmbientScene } from "@/components/scene/lazy-scenes";
import { Button } from "@/components/ui/button";
import { ErrorMessage, DemoBadge, SelfHostedBadge } from "@/components/ui/feedback";
import { Card, Logo } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { ROLE_OPTIONS, GOAL_OPTIONS } from "@/lib/types";
import { cn } from "@/lib/utils";

const STEP_LABELS = ["You", "Your goals", "Your data"];

interface UploadSummary {
  datasetId: string;
  rowCount: number;
  columnCount: number;
  projectId: string;
  profileWarnings: string[];
  sampleName?: string;
  sampleDescription?: string;
}

const SAMPLES = [
  {
    kind: "sales",
    label: "Sales data",
    description: "12 months of transactions: revenue, profit, regions, products",
    icon: "charts",
  },
  {
    kind: "marketing",
    label: "Marketing campaigns",
    description: "Campaign performance across channels: spend, conversions, ROAS",
    icon: "megaphone",
  },
  {
    kind: "web_analytics",
    label: "Web analytics",
    description: "Traffic and engagement: sessions, pageviews, bounce rate",
    icon: "globe",
  },
  {
    kind: "hr",
    label: "Employee data",
    description: "Workforce: departments, salaries, performance, retention",
    icon: "users",
  },
] as const;

export function OnboardingWizard({ name }: { name: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [role, setRole] = useState<string | null>(null);
  const [goals, setGoals] = useState<string[]>([]);
  const [org, setOrg] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [state, setState] = useState<string>("");
  const [entityKind, setEntityKind] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusableRefs = useRef<HTMLDivElement[]>([]);

  const toggleGoal = (value: string) =>
    setGoals((g) => (g.includes(value) ? g.filter((x) => x !== value) : g.length < 5 ? [...g, value] : g));

  // Handle keyboard navigation (ArrowLeft/ArrowRight)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const currentStep = step;

      if (e.key === "ArrowRight" && currentStep < 2) {
        e.preventDefault();
        if (currentStep === 0 && !role) {
          // Don't advance without role selection
          return;
        }
        if (currentStep === 1 && goals.length === 0) {
          // Don't advance without goal selection
          return;
        }
        setStep(currentStep + 1);
      }

      if (e.key === "ArrowLeft" && currentStep > 0) {
        e.preventDefault();
        setStep(currentStep - 1);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [step, role, goals.length]);

  // Track focusable elements for Skip/return navigation
  useEffect(() => {
    const stepContainers = document.querySelectorAll(
      '[aria-label="Step 1 — role"], [aria-label="Step 2 — goals"], [aria-label="Step 3 — upload your dataset"]',
    );
    focusableRefs.current = Array.from(stepContainers) as HTMLDivElement[];
  }, [step]);

  const finishProfile = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ projectId: string }>("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({
          profileRole: role,
          goals,
          organization: org.trim() || undefined,
          state: state.trim() || undefined,
          entityKind: entityKind.trim() || undefined,
          workspaceName: workspace.trim() || undefined,
        }),
      });
      setProjectId(res.projectId);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = (path: string) => {
    router.push(path);
    router.refresh();
  };

  return (
    <main className="relative isolate mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-8">
      {/* Decorative and behind everything: aria-hidden and pointer-transparent
          inside the scene itself, tier-gated to nothing on flat/reduced-motion,
          and behind a dynamic boundary so the wizard's form fields are in the
          route's first load without the renderer. */}
      <LazyAmbientScene className="pointer-events-none absolute inset-0 -z-10" variant="onboarding" />
      <div className="mb-8 flex justify-center">
        <Logo />
      </div>
      <div className="mb-6" aria-label="Progress">
        <ol className="flex items-center justify-between">
          {STEP_LABELS.map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
              <span
                aria-current={step === i ? "step" : undefined}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                  i < step && "bg-accent text-on-accent",
                  i === step && "bg-accent/15 text-accent ring-1 ring-accent",
                  i > step && "bg-surface-2 text-muted",
                )}
              >
                {i < step ? <Check aria-hidden className="size-4" /> : i + 1}
              </span>
              <span
                className={cn(
                  "hidden text-caption font-medium sm:inline",
                  i === step ? "text-foreground" : "text-muted",
                )}
              >
                {label}
              </span>
              {i < STEP_LABELS.length - 1 && <span aria-hidden className="h-px flex-1 bg-line" />}
            </li>
          ))}
        </ol>
      </div>
      <Card className="p-6">
        {error && (
          <ErrorMessage
            title="Something went wrong"
            message={error}
            howToFix="Fix the highlighted input and try again."
            className="mb-4"
          />
        )}

        {step === 0 && (
          <section aria-label="Step 1 — role">
            <h1 className="text-h2 text-foreground">What do you do?</h1>
            <p className="mt-1 text-sm text-muted">Pick the role that best describes you, {name.split(" ")[0]}.</p>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ROLE_OPTIONS.map((option) => (
                <button
                  key={option}
                  onClick={() => setRole(option)}
                  aria-pressed={role === option}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                    role === option
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-line text-muted hover:bg-surface-2",
                  )}
                >
                  <Briefcase aria-hidden className="size-4 shrink-0" />
                  {option}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 1 && (
          <section aria-label="Step 2 — goals">
            <h1 className="text-h2 text-foreground">What are you trying to accomplish?</h1>
            <p className="mt-1 text-sm text-muted">Choose up to 5 — Ledgerly will tailor your starting flow.</p>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {GOAL_OPTIONS.map((g) => {
                const active = goals.includes(g.value);
                return (
                  <button
                    key={g.value}
                    onClick={() => toggleGoal(g.value)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                      active
                        ? "border-accent bg-accent/10 text-foreground"
                        : "border-line text-muted hover:bg-surface-2",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded border",
                        active ? "border-accent bg-accent text-on-accent" : "border-line",
                      )}
                    >
                      {active && <Check aria-hidden className="size-3" />}
                    </span>
                    {g.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Organization (optional)</span>
                <input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="e.g. Northwind GmbH"
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block font-medium text-foreground">State (optional)</span>
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                >
                  <option value="">Select state</option>
                  <option value="maharashtra">Maharashtra</option>
                  <option value="karnataka">Karnataka</option>
                  <option value="west-bengal">West Bengal</option>
                  <option value="tamil-nadu">Tamil Nadu</option>
                  <option value="gujarat">Gujarat</option>
                  <option value="maharashtra">Maharashtra</option>
                  <option value="karnataka">Karnataka</option>
                  <option value="andhra-pradesh">Andhra Pradesh</option>
                  <option value="telangana">Telangana</option>
                  <option value="delhi">Delhi</option>
                  <option value="kerala">Kerala</option>
                  <option value="puducherry">Puducherry</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Entity kind (optional)</span>
                <select
                  value={entityKind}
                  onChange={(e) => setEntityKind(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                >
                  <option value="">Select entity kind</option>
                  <option value="company">Company</option>
                  <option value="llp">LLP</option>
                  <option value="individual">Individual</option>
                </select>
              </label>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1.5 block font-medium text-foreground">Workspace name (optional)</span>
                <input
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="e.g. Growth analytics"
                  className="h-9 w-full rounded-md border border-line bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
                />
              </label>
            </div>
          </section>
        )}

        {step === 2 && (
          <section aria-label="Step 3 — upload your dataset">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-h2 text-foreground">Upload your dataset</h1>
                <p className="mt-1 text-sm text-muted">
                  CSV or XLSX, up to 100 MB. We profile it instantly — your analyses run against{" "}
                  <em>this exact file</em>.
                </p>
              </div>
              <DemoBadge compact tooltip="Demo data is clearly labelled. Upload your own file for real analysis." />
            </div>

            {!summary ? (
              <>
                {/* Sample datasets — jump straight to a rich workspace */}
                <div className="mt-5">
                  <p className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                    <Play aria-hidden className="size-4 text-accent" />
                    No file handy? Try a built-in sample dataset
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SAMPLES.map((s) => (
                      <button
                        key={s.kind}
                        onClick={() => void loadSample(s.kind)}
                        disabled={loadingSample !== null}
                        className="flex items-start gap-3 rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-accent/60 hover:bg-surface-2 disabled:opacity-60"
                      >
                        <SampleIcon kind={s.kind} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">{s.label}</span>
                          <span className="block text-caption text-muted">{s.description}</span>
                        </span>
                        {loadingSample === s.kind ? (
                          <span
                            aria-hidden
                            className="ml-auto size-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
                          />
                        ) : (
                          <span className="ml-auto shrink-0 text-caption text-accent">Load</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-caption text-muted">or upload your own</span>
                  <span className="h-px flex-1 bg-line" />
                </div>

                <div>
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="sr-only"
                    aria-label="Choose CSV or Excel file"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setFile(f);
                      if (f) void uploadWithFile(f);
                    }}
                  />
                  <button
                    onClick={() => inputRef.current?.click()}
                    disabled={uploading}
                    className="flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-line bg-surface-2/40 px-6 py-8 text-center transition-colors hover:border-accent/60 hover:bg-surface-2/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line disabled:opacity-60 focus-visible:bg-surface-2"
                  >
                    {uploading ? (
                      <>
                        <span
                          aria-hidden
                          className="size-6 animate-spin rounded-full border-2 border-line border-t-accent"
                        />
                        <span className="text-sm text-muted">Profiling your file…</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud aria-hidden className="size-8 text-accent" />
                        <span className="font-medium text-foreground">Drag & drop, or click to browse</span>
                        <span className="text-caption text-muted">
                          .csv or .xlsx · max 100 MB · never leaves your workspace
                        </span>
                      </>
                    )}
                  </button>
                  {file && !uploading && !summary && (
                    <p className="mt-2 text-caption text-muted">
                      Selected: <span className="text-foreground">{file.name}</span> — click the area above if you
                      changed your mind.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="mt-5 rounded-md border border-success/40 bg-success/10 p-4">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <FileSpreadsheet aria-hidden className="size-4" />
                  {summary.sampleName ? (
                    <>
                      Sample dataset <span className="text-success">“{summary.sampleName}”</span> imported
                    </>
                  ) : (
                    "Dataset profiled successfully"
                  )}
                </p>
                {summary.sampleDescription && (
                  <p className="mb-3 mt-1 text-caption text-muted">{summary.sampleDescription}</p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ["Rows", summary.rowCount.toLocaleString()],
                    ["Columns", summary.columnCount.toLocaleString()],
                    ["Preview", "First 20 rows"],
                    ["Status", "Ready"],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-caption text-muted">{k}</dt>
                      <dd className="text-body font-semibold tabular-nums text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
                {summary.profileWarnings.length > 0 && (
                  <p className="mt-3 text-caption text-warning">
                    {summary.profileWarnings.length} data-quality notice(s) found — review them on the dataset page.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        <div className="mt-7 flex items-center justify-between">
          {step > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setError(null);
                setStep((s) => s - 1);
              }}
              aria-label="Go to previous step"
              icon={<ArrowLeft aria-hidden className="size-4" />}
            >
              Back
            </Button>
          )}
          {step < 2 && step === 0 && (
            <Button
              onClick={() => {
                setError(null);
                setStep(1);
              }}
              disabled={!role}
              aria-label={!role ? "Select a role to continue" : "Continue to goals"}
              className="ml-auto"
              icon={<ArrowRight aria-hidden className="size-4" />}
            >
              {role ? "Continue" : "Select a role to continue"}
            </Button>
          )}
          {step === 1 && (
            <Button
              onClick={finishProfile}
              loading={busy}
              disabled={goals.length === 0}
              className="ml-auto"
              aria-label="Create workspace and continue"
            >
              {goals.length === 0 ? "Pick at least one goal" : "Create workspace"}
            </Button>
          )}
          {step === 2 && (
            <div className="ml-auto flex gap-2">
              {!summary && (
                <Button
                  variant="ghost"
                  onClick={() => finish("/dashboard")}
                  aria-label="Skip uploading for now"
                  icon={<BarChart3 aria-hidden className="size-4" />}
                >
                  Skip for now
                </Button>
              )}
              {summary && (
                <Button
                  onClick={() => finish(`/projects/${summary.projectId}?tab=datasets`)}
                  aria-label="Start analysing with dataset"
                  icon={<Rocket aria-hidden className="size-4" />}
                >
                  Start analysing
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
      <p className="mt-4 flex items-center justify-center gap-2 text-caption text-muted">
        <Upload aria-hidden className="size-3.5" /> Your data drives every analysis — no sample workspace required.
      </p>
      {step === 2 && (
        <div className="mt-2 text-caption text-muted">
          <SelfHostedBadge /> Hosted wherever you want — self-host with SQLite or PostgreSQL, or use our cloud.
        </div>
      )}
    </main>
  );

  async function uploadWithFile(f: File) {
    if (!projectId) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("projectId", projectId);
      fd.append("file", f);
      const res = await api<UploadSummary>("/api/upload", { method: "POST", body: fd });
      setSummary(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function loadSample(kind: string) {
    if (!projectId) return;
    setError(null);
    setLoadingSample(kind);
    try {
      const res = await api<{
        dataset: { id: string; name: string; rowCount: number; columnCount: number };
        description: string;
      }>("/api/sample-data", {
        method: "POST",
        body: JSON.stringify({ kind, projectId }),
      });
      const s = SAMPLES.find((x) => x.kind === kind);
      setSummary({
        datasetId: res.dataset.id,
        rowCount: res.dataset.rowCount,
        columnCount: res.dataset.columnCount,
        projectId,
        profileWarnings: [],
        sampleName: res.dataset.name,
        sampleDescription: res.description ?? s?.description ?? "",
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingSample(null);
    }
  }
}

function SampleIcon({ kind }: { kind: string }) {
  const cls = "mt-0.5 size-4 shrink-0 text-accent";
  switch (kind) {
    case "marketing":
      return <Megaphone aria-hidden className={cls} />;
    case "web_analytics":
      return <Globe aria-hidden className={cls} />;
    case "hr":
      return <Users aria-hidden className={cls} />;
    case "sales":
    default:
      return <BarChart3 aria-hidden className={cls} />;
  }
}
