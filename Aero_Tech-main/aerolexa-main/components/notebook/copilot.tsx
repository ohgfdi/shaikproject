/**
 * Phase 2.3 — AI Copilot Code Completion for Notebook Cells
 *
 * Provides inline code completion suggestions as users type in notebook code cells.
 * Integrates with the existing Pyodide kernel and DSL engine for context-aware suggestions.
 *
 * Features:
 * - Autocomplete for pandas DataFrame methods (.head(), .describe(), etc.)
 * - Autocomplete for common Python functions (pd.read_csv, plt.show, etc.)
 * - Context-aware suggestions based on dataset columns
 * - Natural language trigger: type /llm followed by a request
 * - Inline insert with Tab key
 * - Falls back to simple tab-completion when LLM is unavailable
 */

// Re-export the hook
export { useNotebookCopilot } from "./copilot-hook";
