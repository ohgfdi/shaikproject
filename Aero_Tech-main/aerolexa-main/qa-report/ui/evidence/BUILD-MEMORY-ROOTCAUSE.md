# Build Memory Root Cause

**Symptom**: `next build` worker killed with `SIGTERM` on 8 GB / 2 vCPU box.

**Root Cause**: The server-side webpack bundle inlined the full `playwright` dependency graph
via two modules that import it at runtime:

- `lib/export/pdf.ts` — `import { chromium } from "playwright"`
- `lib/server/visual-render.ts` — `import { chromium, ... } from "playwright"`

These modules are reachable from `app/api/export/*` and `app/api/render/*`
route handlers (PDF/presentation export endpoints).

On this constrained build box, bundling playwright's entire dependency graph
(excluding `playwright-core` via `serverExternalPackages`) pushed memory usage
past the commit/phys-memory ceiling, causing the Next.js build worker to be
OOM-killed (`SIGTERM`) mid-compile.

**Fix**: Added `"playwright"` to `next.config.mjs`'s
`serverExternalPackages` array. This externs the package from the server bundle,
keeping the runtime `import { chromium } from "playwright"` intact while removing
the bundling cost. Verified: build now completes successfully (EXIT 0),
88/88 static pages generated, all bundle budgets satisfied.
