# Phase 2.3 — AI Copilot Embedded in Notebook

## What It Builds

The differentiating feature that separates Hex from general data science tools — an embedded AI copilot within the notebook interface that assists users by:

- **Code completion and generation**: Suggesting valid Python code as users type in cells, including proper imports, DataFrame operations, and matplotlib/seaborn rendering commands
- **Natural language to code**: Translating user requests like "show me a correlation heatmap" into executable Python/pandas code
- **Context-aware suggestions**: Understanding the current dataset schema, previously run cells, and notebook context to provide relevant completions
- **Error explanation and fixing**: Identifying common Python/pandas errors and suggesting fixes
- **Interactive what-if**: Perturbing parameters and showing expected output changes without re-running the full cell
- **Export assistance**: Helping users export analyses as runnable Python scripts or .ipynb notebooks

## Verification Criteria

A test suite must confirm the following are genuine working capabilities, not stubs or mocks:

| Criterion                                             | Verification Method                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Code completion loads**                             | Copilot UI component mounts without requiring feature flags or API keys in NEXT_PUBLIC environment                          |
| **NL-to-code generation produces runnable Python**    | Generated Python scripts can be executed in a clean `.venv` and produce numeric results matching the app's displayed values |
| **Context-aware suggestions use real dataset schema** | Suggestions reference actual column names, types, and from the uploaded dataset (not hardcoded values)                      |
| **Error explanation references actual errors**        | When a cell fails, the copilot identifies the real error type and message, not generic messages                             |
| **What-if perturbations are computed real**           | Changing a parameter value and previewing the result recomputes using the same underlying engine, not simulated/fake values |
| **Export to .ipynb preserves outputs**                | Exported notebooks are valid nbformat 4 JSON with cells, outputs, and metadata preserved                                    |

## Open Questions / Gaps

- No existing code or component for AI copilot in the notebook interface
- No LLM integration (OpenAI/Claude API keys, endpoints)
- No natural language to code generation pipeline
- No context-aware suggestion system built on top of the existing DSL engine
- No copilot UI components in the notebook editor
- No test suite exists for copilot functionality

## Dependencies on Other Phases

- **Must complete Phase 2.2 first** (publish-as-app, input widgets, view-only sharing) since the copilot needs to work within the published/app shell
- **Requires Phase 1.5 code export to be real** — the copilot's "export code" feature depends on the `lib/export/python` module working correctly (currently PARTIAL due to triple-quote syntax errors in generated scripts)
- **Benefits from Phase 1.1 (Pyodide execution)** — inline code execution within the notebook for immediate feedback
- **Builds on Phase 1.3 (multi-dataset support)** — copilot should understand and suggest operations across multiple joined datasets

## Verification Prompt (to run after implementation)

Create a prompt file following the project pattern (e.g., `phase_2.3_verification_prompt.md`) that tests:

1. **Copilot component renders** — `npx tsc --noEmit` shows no errors for copilot-related files
2. **NL-to-code generates valid Python** — Run exported script in `.venv`, compare `RESULT:` output to app display
3. **Context uses real schema** — Test with 2+ datasets joined; suggestions reference correct column names
4. **Error explanation is accurate** — Provide a broken cell output; copilot identifies correct error type/message
5. **What-if computes real metrics** — Perturb a parameter; verify the recomputed result matches the engine's output
6. **Export .ipynb is valid** — Generate notebook; run `nbformat.validate()` and confirm no discrepancies

## Status

**Not started** — No implementation exists. This is the next phase to begin after:

- `close_phase_2.2_gaps_master_prompt.md` confirmed (Phase 0 ✅, Phase 1 ✅)
- Tier 1 verification pass completed (1.1-1.5 verified, statuses documented)
- Phase 1.5 code export syntax errors resolved (currently PARTIAL — triple-quote fixes needed)
