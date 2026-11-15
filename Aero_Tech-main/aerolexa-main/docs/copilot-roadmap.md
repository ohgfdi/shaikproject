# Copilot & AI roadmap — AI narrates, engines compute (ROADMAP Phase 6)

Ledgerly's AI architecture is already right: a tool-calling agent
(`lib/copilot/agent.ts`) whose ONLY interface to the world is
`lib/copilot/tools.ts` (get_schema / compute_metrics / run_analysis /
finish), with a grounding guard (`lib/copilot/guard.ts`) that verifies every
number in the model's answer against computed facts before it reaches the
user. Works hosted (OpenAI-compatible) or fully local (Ollama). The eval
suite (`__tests__/unit/copilot-eval/`) pins golden question→engine-call
pairs in CI.

> **Status: IMPLEMENTED (Sept 2026).** A1–A4 have landed:
> A1 `POST /api/dashboards/[id]/copilot` + `components/dashboards/dashboard-copilot.tsx`;
> A2 `lib/copilot/narrative.ts` wired into the insights route and digest notifications;
> A3 `lib/copilot/measure-proposal.ts` + the `propose_measure` tool;
> A4 `__tests__/unit/copilot-eval/copilot-roadmap-eval.test.ts` (offline goldens + fabrication red team).

This document sequences the NEXT four increments. The rule that never
changes: **the model may name only what the engine computed — the label
`calculated | inferred | recommendation` travels with every value.**

## A1. Copilot on dashboards — "explain this page"

Today the agent is grounded in ONE dataset (dataset-copilot). Next: bind it
to a dashboard context — the visible widgets' specs + their saved
cross-filter/slicer state — so it can answer "why is Q3 flat?" about the
page you are looking at.

- **Do:** a `get_dashboard_context` tool that returns widget metadata and
  lets the agent call the EXISTING compute/analysis engines with the
  dashboard's filters applied. Reuses the RLS choke points — a viewer's
  copilot answers respect row-level security because they flow through
  `loadDatasetFrame`.
- **Done when:** an answer about a filtered dashboard cites the widget and
  the filter context that produced each number, and the eval suite gains
  dashboard-context golden pairs.
- **Effort:** ~1 week. Files: `lib/copilot/tools.ts`,
  `components/dashboards/dashboard-builder.tsx` (chat entrypoint).

## A2. Anomaly narratives — scheduled, grounded

The insights engine already computes anomalies with severity + evidence.
Next: attach an LLM-written narrative to an ALREADY-COMPUTED anomaly
(narration only — the model may reorder, phrase, and explain; it may not
introduce a number), and push those into the notification digest
(`DIGEST_ENABLED`) so a weekly email says _what moved and by how much_ with
the computed evidence attached.

- **Done when:** every narrative number carries a provenance id resolving to
  the computed fact; the guard rejects any narrative containing an unverified
  numeric token; digest emails include top anomalies.
- **Effort:** ~1 week. Files: `lib/copilot/guard.ts` (numeric tokenizer),
  `lib/engine/insights` narrative step, `lib/server/notify-digest.ts`.

## A3. Natural-language → measure (the DAX bridge)

The DAX engine has 90 oracle-tested functions and a semantic layer with
relationships. Next: NL → measure definition with the model proposing, the
engine verifying: the model writes a candidate DAX expression; the system
runs it against real data, compares against a naïve recomputation where one
exists, and only then offers the measure for save — with the expression,
not the model's prose, as the source of truth.

- **Done when:** a saved NL-created measure renders identical results to the
  hand-written equivalent in the eval suite; invalid DAX is surfaced with the
  engine's real error message.
- **Effort:** ~2 weeks. Files: `lib/engine/dax.ts` (already exposes an eval
  entrypoint), `lib/copilot/tools.ts` (+`propose_measure`),
  semantic-layer UI.

## A4. Copilot eval expansion + recorded fixtures

Phase 6.3's eval suite exists; expand it to gate all of the above: recorded
LLM fixtures (no live API in CI), golden pairs for dashboard context,
narratives, and measure proposals, plus a "fabrication red team" fixture set
— prompts crafted to bait the model into inventing numbers, asserting it
never does.

- **Done when:** `npm test` fails on any regression in tool-calling,
  grounding, or refusal behaviour — without network access.
- **Effort:** ~1 week. Files: `__tests__/unit/copilot-eval/`.

## Sequencing and why

```
A1 (dashboards) ──► A2 (narratives + digest) ──► A3 (NL measures) ──► A4 (eval wall)
```

A1 first: it multiplies the value of everything the product already computes
and needs no new engine work. A2 rides A1's context plumbing and closes the
"product feels alive even when I'm not looking" gap. A3 is the deepest
engineering (verification of generated expressions) and benefits from the
eval wall in A4 being in place first if the team prefers — the order of
A3/A4 can swap.
