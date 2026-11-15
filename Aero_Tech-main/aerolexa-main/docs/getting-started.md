# Getting started — first value in 15 minutes

The pitch of Ledgerly is _"from raw data to boardroom decisions."_ This guide
is the evaluator's proof: one CSV in, a dashboard out, everything computed
from your file — nothing invented. (The same path is asserted end-to-end by
the Playwright journey in `__tests__/e2e/`.)

## 0. Install and run

```bash
npm install
npm run dev        # creates .env if missing → applies migrations → starts Next.js
```

Open http://localhost:3000. Prefer Docker? `docker compose up --build` gives
you the same app with zero external services; the production Postgres path is
[`deploy-postgres.md`](deploy-postgres.md).

## 1. Sign up and tell it who you are (1 min)

Email + password, then a 3-step wizard (role, goals, data). Your answers
shape the workspace — nothing is sent anywhere.

## 2. Get data in (2 min)

On the last wizard step, either:

- **Upload** your own CSV/XLSX, or
- **Pick a sample** (sales, marketing, web analytics, HR) — clearly labelled
  `Demo / Synthetic`, so no result can ever masquerade as your real numbers.

Profiling runs automatically: column types, distributions, quality warnings.
Anything odd in your file is surfaced, not smoothed over.

## 3. Look at what the engine says (3 min)

- **Dataset → Profile** — column-level statistics, every one labelled
  _Calculated_ and reproducible (the CI compares the engine against
  SciPy/NumPy oracles).
- **Run an EDA analysis** — trend, correlation, distribution. Each result has
  a **"How was this calculated?"** disclosure; if a number cannot show its
  work, the UI does not call it calculated.
- **Business Advisor** — reads the same real columns. Prototype-labelled
  features say so; that is the honesty contract, enforced across the product.

## 4. Build a dashboard (5 min)

Dashboard Builder → **Add widget**. KPI cards, charts, tables, and the
Power BI visual set (waterfall, funnel, treemap, gauge, heatmap…) plus the
Leaflet filled map. Click a slice to **cross-filter** every other tile,
shift-click for **drill-through**, drop a **slicer** for real Power-BI-style
filtering. Add a title, hit **Save**, then **Share** to get a read-only
published link.

## 5. Ship something to the board (3 min)

- **Reports** — 12-section executive template auto-populated from your
  dataset; export to PDF (real Chromium print) or HTML.
- **Presentations** — 9-slide deck with your insights and charts embedded.
- **Scheduled reports** — put it on cron; when `SCHEDULER_ENABLED=true` the
  runs execute in the background, land in data/exports, and notify recipients.

## 6. Turn on the copilot (optional, one variable)

Set `LLM_API_KEY` in `.env` (any OpenAI-compatible endpoint works; set
`LLM_PROVIDER=ollama` to keep everything on-machine) and restart. The copilot
can then answer questions about your dataset — but **a live model is
optional**: every numeric answer is computed by the deterministic engines and
verified by the grounding guard (`lib/copilot/guard.ts`); the model narrates,
the engine computes. Without a key, all analyses still run — only the chat
narration is disabled, and the UI tells you so.

## 7. Connect Google web search (optional, two variables)

Copilot chat ships with a free, key-less DuckDuckGo search fallback. For
Google results, create a free Programmable Search Engine
(programmablesearchengine.google.com → enable "Search the entire web", then
create an API key in Google Cloud Console with the Custom Search API enabled)
and set in `.env`:

```
GOOGLE_CSE_API_KEY=<your key>
GOOGLE_CSE_ENGINE_ID=<your engine id (cx)>
```

Restart. The chat header shows an honest badge — "Google connected" when the
pair is set, "Web search (DuckDuckGo)" otherwise (see `GET
/api/search/status`). The free tier covers 100 queries/day.

## Where everything lives

| Area                                                                                       | Where                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Analyst modules (SQL Lab, notebooks, what-if, training, connectors, advisor, prompts, LLM) | On by default. Set `LEDGERLY_PROFILE=core` in `.env` to freeze them; see the profile docs in `.env.example` |
| API keys + OpenAPI explorer                                                                | Settings → API keys; docs at `/api/docs`                                                                    |
| Notification digest (email bundle)                                                         | `DIGEST_ENABLED=true`                                                                                       |
| Audit log + CSV export                                                                     | Settings → Audit                                                                                            |

## When something looks wrong

| Symptom                              | What it means                                                                        | Fix                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| "ENGINE_UNAVAILABLE" in SQL Lab      | DuckDB could not initialize                                                          | Check `DUCKDB_ENABLED` / restart; the app refuses to silently downgrade results |
| Empty charts                         | The dataset really has no rows for that filter — filters compose; clear the chip bar | Clear cross-filter chips                                                        |
| Upload rejected                      | Row/size cap hit (honest cap, not a crash)                                           | Raise `MAX_UPLOAD_BYTES` or split the file                                      |
| Copilot banner "no model configured" | No `LLM_API_KEY`                                                                     | Optional — set the key, or keep using the deterministic engines                 |

## Next reading

- [`deploy-postgres.md`](deploy-postgres.md) — production runbook
- [`security-and-data.md`](security-and-data.md) — isolation, RLS, audit
- [`quality-baseline.md`](quality-baseline.md) — the measured scoreboard
