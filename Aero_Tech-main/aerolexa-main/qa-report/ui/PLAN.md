# UI + CA-firm exposure — root-cause analysis and fix plan

Status: **analysis only, no code changed yet.**
Base: `083413f` on `ui/ca-exposure`. Acceptance checks: `qa-report/ui/expected.json` (written before this file; no expectation edited since).

## Evidence used

| Artifact                                                               | What it shows                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before/sidebar-dom-1440.html`                                         | One desktop `<aside>`; every nav row contains a `<summary>` label **and** an `<a>` with the same label                                                |
| `evidence/BASELINE.json`                                               | 1440px: 1 aside, 1 `nav[aria-label=Primary]`, `scrollWidth=315` vs `clientWidth=255`                                                                  |
| `evidence/probe-1440.png`                                              | Visual duplicate rows, 2× each label                                                                                                                  |
| `evidence/probe-after-toggle.png`                                      | After pressing "Menu": a second absolutely-positioned search input appears inside the rail                                                            |
| `evidence/probe3.mjs` output (in transcript, reproduced by `repro.sh`) | After opening the drawer on desktop: 2 `<aside>` elements, one 256×900, one 0×0 behind `lg:hidden`; at 390px the 256px desktop rail is still laid out |
| `qa-report/ui/evidence/dev.log`                                        | Console on load: CSP directive `plugin-types` removed from the specification                                                                          |

## D1 — every sidebar item renders twice — **CONFIRMED**

`components/layout/app-shell.tsx:230-253`. Each `MAIN_NAV.map` iteration returns a `<div>` containing:

1. `<summary>` (line 230) — an icon, a truncating `<span>{item.label}</span>`, a chevron. Never wrapped in `<details>`, so it renders as a permanent row.
2. `<a href>` (line 241) — the same icon, the same label, `aria-current`.

A `<summary>` is not a link and has no click handler, hence the bold "label + chevron" row above the lighter duplicate. That is the exact screenshot pattern.
Second, independent duplication at <1024px: the desktop `<aside>` (line 294) has no `hidden lg:block` (it only has `lg:block`, which does not hide it below `lg`), so it stays in layout while the drawer (line 299) mounts a complete second nav. At 390px two copies of the nav exist (one under the drawer overlay).

**Fix:** one `<Link>` per item, no `<summary>`, no chevron, no nested nav. Render the rail only at `md+` (`hidden md:flex`) and the drawer only below `md`.

## D2 — second search box overlaps the rail — **CONFIRMED**

`components/layout/search-in-sidebar.tsx:52` positions the input `absolute left-0 right-0 top-6` inside the rail; it is mounted by `app-shell.tsx:217` whenever `sidebarOpen` is true. It overlaps the first nav rows and truncates its placeholder inside 256px. The header already has the global command-palette search (`app-shell.tsx:406`), so this is a duplicate with no unique behaviour (it never calls `/api/search`; `search-in-sidebar.tsx:38-48` only closes the drawer).

**Fix:** delete `search-in-sidebar.tsx` and its mount. The header's one search button opens the existing `CommandPalette`.

## D3 — sidebar text overflows — **CONFIRMED**

- Rail width: `w-64` = 256px (`app-shell.tsx:294`); content offset: `lg:pl-60` = 240px (`app-shell.tsx:394`) → a 16px overlap by construction.
- Only the `<summary>` span truncates (line 232). The `<a>` (line 250) renders `{item.label}` with no `min-w-0`/`truncate`, so "Presentations" and "Business Advisor" widen the row.
- Measured `scrollWidth 315 > clientWidth 255`.

**Fix:** rail is exactly 256px/72px via a `--sidebar-w` variable used by both the rail and the content offset; every row gets `min-w-0` + `truncate` + `title`; the nav gets its own scroll container.

## D4 — Hindi shown, English content — **CONFIRMED**

`lib/i18n.ts:22` `DEFAULT_LOCALE = "hi"`. The root layout uses it for `<html lang>` and the switcher selects हिन्दी, but the shell and nearly all copy are hard-coded English (e.g. all labels in `app-shell.tsx`). Only the ~30 keys in `lib/locales/*.ts` are translated.

**Fix:** default to `en`. Keep Hindi/Urdu because they do translate the strings that call `t()` (not zero coverage), but label them "(partial)" in the switcher and state coverage in the tooltip. No option that does nothing.

## D5 — CA capabilities not reachable — **CONFIRMED**

`app/(app)/books/page.tsx` (client books, trial balance, P&L, balance sheet, cash flow, GST filing/TDS) and `app/(app)/statutes/page.tsx` (rule & rate registry) have no entry in `CORE_NAV`/`ALWAYS_NAV` (`app-shell.tsx:62-88`). `CA Compute` and `CA Sources` are in `ALWAYS_NAV` but flat and below an unscrollable rail. `/api/gst/itc-recon` is wired only inside the Books GST tab.

**Fix:** grouped nav with `WORKSPACE | CLIENT WORK | COMPLIANCE | ANALYTICS | SETTINGS`; add Client Books and Rule & Rate Registry; rename CA items to their user-facing jobs; add to command palette; surface client/deadline/import status on the dashboard. Anything with no page stays in `docs/BACKLOG.md` and out of the nav.

## Additional defects found

- **D6 — CSP console error — CONFIRMED.** `lib/server/security-headers.ts:90` emits `plugin-types`, removed from the CSP spec. Chromium logs an error on every page (verbatim: "The Content-Security-Policy directive 'plugin-types' has been removed from the specification."). Remove the directive; no code consumes plugins.
- **D7 — collapse controls do nothing to the desktop rail — CONFIRMED.** `sidebarOpen` only gates the mobile drawer; the "Toggle sidebar"/"Collapse" buttons (`app-shell.tsx:190-212`) have no effect on the fixed rail. No collapsed state exists, no persistence.
- **D8 — no brand row in the desktop sidebar — CONFIRMED.** The only `Logo` in the shell is in the mobile drawer (line 302) and header (line 403, `lg:hidden`). The rail starts with the Menu button.
- **D9 — rail cannot scroll — SUSPECTED (needs a short-viewport capture).** `aside` has no `overflow-y-auto`; at 900px the 13 duplicated rows exceed the viewport and the trailing CA/Settings rows are unreachable. This is why D5's items are invisible in the screenshot even though they are in `ALWAYS_NAV`.
- **D10 — six separate active states can be simultaneously true — CONFIRMED by inspection.** `isActive` compares `pathname.startsWith(cleanHref)` only (`app-shell.tsx:171-174`), so `/settings?tab=deliverables`, `/settings?tab=report-templates` and `/settings` all mark active together; `/ca-sources` and `/ca-compute` are distinct but `/search` is also in the action block. Query-aware matching is required.

## Files to change

| File                                      | Change                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/layout/app-shell.tsx`         | Rewrite shell: grouped single nav, brand row, 256/72 rail, persistence, mobile drawer + focus trap, one header search, profile menu, desktop collapse |
| `components/layout/nav-config.tsx` (new)  | Single source of truth for groups/items/hrefs, shared by sidebar and command palette                                                                  |
| `components/layout/search-in-sidebar.tsx` | Delete (duplicate search)                                                                                                                             |
| `components/layout/command-palette.tsx`   | Derive actions from nav config; add Books/Statutes; keep CA entries                                                                                   |
| `components/i18n/locale-switcher.tsx`     | Honest partial-coverage labels; default English                                                                                                       |
| `lib/i18n.ts`                             | `DEFAULT_LOCALE = "en"`; document coverage                                                                                                            |
| `lib/locales/en.ts`                       | Add nav/group keys used by the shell                                                                                                                  |
| `lib/server/security-headers.ts`          | Remove `plugin-types`                                                                                                                                 |
| `app/(app)/dashboard/page.tsx`            | CA-firm work queue block: clients, filing deadlines, reconciliation status, imports, exceptions                                                       |
| `styles/globals.css`                      | Reduced-motion transition guard + sidebar width variable (only if Tailwind utilities are insufficient)                                                |

No new dependencies. All icons from the existing `lucide-react` set. Existing tokens (`surface`, `surface-2`, `line`, `accent`, `foreground`, `muted`) only.

## Out of scope (to BACKLOG, not UI)

- GST notices / multi-GSTIN / e-way bill / RCM / supplier monitoring: POST-only compute APIs with no persisted workflow and no page. Documented as BACKEND-ONLY.
- E-invoice IRN, portal automation, compliance calendar, payroll, FEMA/TP/Ind AS: engine-only. NOT BUILT in the UI.

## Acceptance mapping

Every fix has a pre-registered check in `expected.json` (`C01`–`C28`). The BEFORE run is a negative control: `C01`, `C02`, `C03`, `C04`, `C05`, `C06`, `C07`, `C08`, `C09`, `C10`, `C12`, `C18`, `C19`, `C22`, `C24`, `C28` are expected to fail before the change and must pass after.
