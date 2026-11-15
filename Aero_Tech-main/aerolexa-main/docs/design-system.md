# Ledgerly Design System

Ledgerly ships one consistent, accessible design system. Every screen is built
from the primitives in `components/ui/` — ad-hoc styling is a review failure.

## Core principles

- **Accessibility first (WCAG AA)**: semantic HTML, keyboard navigation,
  visible focus rings, ≥ 4.5:1 text contrast in both themes, labels linked to
  fields, no color-only communication, skip links.
- **Responsive & mobile-first**: 375 px → 1440 px. The sidebar collapses to a
  drawer below 1024 px; a bottom navigation appears below 640 px. No horizontal
  overflow on any screen (`no-hscroll` utility on the app shell).
- **Honest states**: every view shows Loading (skeleton), Empty (illustration +
  CTA), Success (toast), or Error (inline with "What happened?" + "How to fix").
  Data-quality findings surface in dismissible `WarningBanner`s. Never a blank
  screen, never a silent spinner.
- **Data truth**: prototype/demo logic is labelled with the "Prototype / Demo" badge.
  Statistically-validated analyses (EDA, KPI, distribution, correlation, trend) are
  compared against SciPy/NumPy oracles in CI and are NOT badged as prototype.
  Real uploaded data drives every chart and number.

## Tokens

Defined as CSS variables in `styles/globals.css` and mapped through Tailwind.

| Token                   | Light          | Dark      | Usage                         |
| ----------------------- | -------------- | --------- | ----------------------------- |
| `--bg` / `background`   | `#F7F7F5`      | `#0A0A0A` | Page background               |
| `--surface`             | `#FFFFFF`      | `#121212` | Cards, inputs                 |
| `--surface-2`           | `#F1F0EC`      | `#1C1C1C` | Hover, headers                |
| `--surface-3`           | `#E9E8E2`      | `#262626` | Tooltips                      |
| `--line`                | `#E5E5E5`      | `#2A2A2A` | Borders                       |
| `--accent`              | teal `#0E7C7E` | `#5AA8AA` | Primary actions, links        |
| `--accent-strong`       | `#0B6A6C`      | `#7BC4C6` | Accent hover                  |
| `--on-accent`           | `#FFFFFF`      | `#062A2B` | Text on accent                |
| `--focus`               | `#0066FF`      | `#0066FF` | 2 px focus ring (both themes) |
| `--danger`              | `#B42318`      | `#F97066` | Errors, destructive           |
| `--success`             | `#067647`      | `#47CD89` | Success                       |
| `--warning` / `--amber` | `#B54708`      | `#FFB400` | Warnings, demo badge          |
| `--info`                | `#175CD3`      | `#528BFF` | Informational                 |
| `--muted`               | `#5D5D5D`      | `#A0A0A0` | Secondary text                |
| `--foreground`          | `#1A1A1A`      | `#E5E5E5` | Primary text                  |

60/30/10: neutral surfaces dominate (~60 %), text/foreground ~30 %, and the
accent is used sparingly for actions and emphasis (~10 %). Chart palettes keep
every categorical series distinguishable in both themes (`CHART_PALETTE`).

### Typography

Modern sans (Inter stack). All sizes in `rem`, line-height 1.5.

| Role            | Tailwind class | Size            |
| --------------- | -------------- | --------------- |
| Display / h1    | `text-h1`      | 2rem (32 px)    |
| h2              | `text-h2`      | 1.5rem (24 px)  |
| h3              | `text-h3`      | 1.25rem (20 px) |
| Body            | `text-body`    | 1rem (16 px)    |
| Caption / small | `text-caption` | 0.75rem (12 px) |

### Spacing

Base unit 4 px; all spacing is a multiple of 4 (`p-1` … `p-12`, Tailwind
defaults already satisfy this). Generous gaps between sections, tight spacing
inside components.

## Component library (`components/ui/`)

| Component                                                                                 | File                       | Notes                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `Button` / `IconButton`                                                                   | `button.tsx`               | primary/secondary/ghost/danger/amber; loading spinner; `focus-visible` ring      |
| `Input` `Textarea` `Select` `Checkbox` `Field`                                            | `form.tsx`                 | label + helper + error (`role=alert`), `aria-invalid`, required marker           |
| `Card` `CardContent` `Badge` `Avatar` `Logo` `Progress`                                   | `primitives.tsx`           | 1 px `--line` border, subtle radius                                              |
| `Table` `Th` `Td` `DataTable`                                                             | `table.tsx`                | sticky header, horizontal scroll < 640 px, pagination > page size                |
| `Dialog` `Dropdown` `Tooltip` `ToastProvider`/`useToast`                                  | `overlays.tsx`             | keyboard (Esc) + focus managed                                                   |
| `EmptyState` `DemoBadge` `WarningBanner` `ErrorMessage` `ErrorBoundary` `LoadingSkeleton` | `feedback.tsx`             | all screens' state vocabulary                                                    |
| Tabs / segmented controls                                                                 | inline with `role=tablist` | consistent pill styles                                                           |
| Charts                                                                                    | `components/charts/`       | Apex wrapper + custom heatmap/funnel/waterfall/KPI; `CalcExplainer`, `StatChips` |

## Accessibility checklist (review gate)

- axe-core clean on every page; Lighthouse accessibility ≥ 90.
- Focus rings: 2 px, `--focus` blue, visible on `:focus-visible`.
- All interactive controls reachable + operable by keyboard (tab order follows
  the visual layout; dialogs trap focus; Esc closes).
- Charts carry `aria-label`s; export HTML embeds SVG with roles and labels.
- Color is never the only channel — icons/text pair with color everywhere.
- Long pages expose a skip link ("Skip to main content").

## The 3D realism system

The app's WebGL scenes are one system, built on measured capability — never guessed.

| Rule                             | Detail                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tier decides whether**         | `lib/scene/tier.ts` measures WebGL, dpr, cores, memory, `prefers-reduced-motion` → `studio` / `depth` / `flat`. `flat` renders nothing; 2D fallback is pixel-equivalent.                                                                 |
| **Quality decides how well**     | `lib/scene/quality.ts` derives the post stack, shadow map size, env resolution, instance budgets, dpr clamp per tier. Scene components never hardcode counts or sizes.                                                                   |
| **One canvas factory**           | Every scene mounts through `components/scene/scene-canvas.tsx` — ACES tone mapping, IBL environment, post stack, PerformanceMonitor with recorded runtime downgrade. No page ships two overlapping canvases.                             |
| **One material library**         | `lib/scene/materials.ts`: `dataGlass` (charts), `brushedMetal` (hero), `softTouch` (matte), `lightEdge` (focus states). Cached instances per (kind, color, theme); ad-hoc `<meshStandardMaterial>` inline in scenes is a review failure. |
| **3D is a view, never a source** | Any object encoding data mirrors a value an engine computed (oracle-tested layout modules, e.g. `lib/scene/heatmap.ts`). The scene version of "no hallucinated results".                                                                 |
| **Motion is tokenized**          | `lib/scene/motion.ts`: durations, curves, springs shared by DOM (framer-motion) and scenes (R3F). Reduced motion drops the tier to flat — enforced by e2e.                                                                               |
| **Decorative = aria-hidden**     | Scenes never take focus, never carry information that isn't also in DOM text, and the flat tier hides nothing.                                                                                                                           |

Bundle rule: the 3D runtime is always `next/dynamic` + `ssr: false`, never in a route's first-load bundle; the build's budget gate (`scripts/check-bundle-budgets.mjs`) fails the build if a route crosses 300 kB.

## Component API notes

- `DemoBadge({ compact?, tooltip? })` — for results computed by prototype or
  demonstration logic ONLY. Do NOT use on SciPy-validated analyses (EDA, KPI,
  distribution, correlation, trend). Tooltip default: "Calculated using
  prototype logic; live ML pipelines coming soon."
- `ErrorMessage({ title?, message?, howToFix?, onRetry? })` renders a disclosure
  for "What happened?" — never a stack trace.
- `ChartRenderer({ spec, numStyle, height, bare })` renders any `ChartSpec` the
  engine emits; use `bare` for embedding without the figure chrome.
