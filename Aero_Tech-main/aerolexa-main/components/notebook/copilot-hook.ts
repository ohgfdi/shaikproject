"use client";

/**
 * Notebook copilot hook.
 *
 * Provides two layers of assistance for code cells:
 *
 * 1. Static autocomplete — DSL commands, dataset columns and pandas methods,
 *    filtered by what the user is typing.
 * 2. Natural language (`/llm <request>`) — sends the request to
 *    /api/notebooks/[id]/ai, which translates it into a runnable cell
 *    (deterministic assistant by default, live Claude when ANTHROPIC_API_KEY
 *    is configured) and returns the code plus a plain-language explanation.
 *
 * The hook is UI-agnostic; CopilotTextarea renders the dropdown.
 */

import { useCallback, useRef, useState } from "react";

export type SuggestionType = "builtin" | "pandas" | "column" | "keyword" | "llm";

export interface SuggestionItem {
  label: string;
  value: string;
  description: string;
  type: SuggestionType;
}

export interface LlmSuggestion {
  code: string;
  explanation: string;
}

const DSL_SUGGESTIONS: SuggestionItem[] = [
  { label: "%help", value: "%help", description: "List all notebook commands", type: "keyword" },
  { label: "%rows", value: "%rows 20", description: "Preview the first rows", type: "keyword" },
  { label: "%columns", value: "%columns", description: "Show the dataset schema", type: "keyword" },
  { label: "%profile", value: "%profile", description: "Data-quality overview", type: "keyword" },
  { label: "%describe", value: "%describe ", description: "Numeric stats for one column", type: "keyword" },
  { label: "%kpi", value: "%kpi ", description: "Totals, averages and extremes of a metric", type: "keyword" },
  { label: "%trend", value: "%trend  by ", description: "A metric over time", type: "keyword" },
  { label: "%corr", value: "%corr  ", description: "Correlation between two columns", type: "keyword" },
  { label: "%histogram", value: "%histogram ", description: "Distribution of one numeric column", type: "keyword" },
];

const PYTHON_BUILTINS = [
  "pd",
  "np",
  "plt",
  "df",
  "print",
  "len",
  "sum",
  "min",
  "max",
  "mean",
  "range",
  "round",
  "str",
  "int",
  "float",
  "list",
  "dict",
  "set",
  "import",
  "from",
  "def",
  "return",
];

const PANDAS_METHODS = [
  "head",
  "tail",
  "describe",
  "info",
  "groupby",
  "agg",
  "sort_values",
  "value_counts",
  "dropna",
  "fillna",
  "rename",
  "astype",
  "merge",
  "pivot_table",
  "corr",
  "plot",
  "unique",
  "nunique",
  "sum",
  "mean",
  "median",
];

export interface UseNotebookCopilotOptions {
  datasetColumns?: string[];
  notebookId?: string | null;
  datasetName?: string | null;
}

export interface UseNotebookCopilotReturn {
  suggestions: SuggestionItem[];
  isVisible: boolean;
  highlightedIndex: number;
  llmLoading: boolean;
  llmError: string | null;
  llmSuggestion: LlmSuggestion | null;
  filterSuggestions: (query: string) => void;
  close: () => void;
  setSuggestions: (items: SuggestionItem[]) => void;
  setIsVisible: (visible: boolean) => void;
  setHighlightedIndex: (index: number) => void;
  triggerLlm: (userQuery: string) => Promise<void>;
  clearLlm: () => void;
}

export function useNotebookCopilot(options: UseNotebookCopilotOptions = {}): UseNotebookCopilotReturn {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmSuggestion, setLlmSuggestion] = useState<LlmSuggestion | null>(null);
  const requestSeq = useRef(0);

  const close = useCallback(() => {
    setIsVisible(false);
    setSuggestions([]);
    setHighlightedIndex(-1);
  }, []);

  /** Filter static suggestions by the token the user is typing. */
  const filterSuggestions = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) {
        close();
        return;
      }
      const q = trimmed.toLowerCase();
      const items: SuggestionItem[] = [];
      for (const item of DSL_SUGGESTIONS) {
        if (item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)) items.push(item);
      }
      for (const column of options.datasetColumns ?? []) {
        if (column.toLowerCase().includes(q)) {
          items.push({ label: column, value: `df["${column}"]`, description: "Dataset column", type: "column" });
        }
      }
      for (const fn of PYTHON_BUILTINS) {
        if (fn.toLowerCase().includes(q))
          items.push({ label: fn, value: fn, description: "Python built-in", type: "builtin" });
      }
      for (const method of PANDAS_METHODS) {
        if (method.toLowerCase().includes(q)) {
          items.push({
            label: `df.${method}()`,
            value: `df.${method}()`,
            description: "pandas method",
            type: "pandas",
          });
        }
      }
      setSuggestions(items);
      setIsVisible(items.length > 0);
      setHighlightedIndex(items.length > 0 ? 0 : -1);
    },
    [options.datasetColumns, close],
  );

  /** Ask the notebook AI route to translate a natural-language request. */
  const triggerLlm = useCallback(
    async (userQuery: string) => {
      const seq = ++requestSeq.current;
      if (!options.notebookId) {
        setLlmError("Open a notebook first, then try /llm again.");
        setLlmLoading(false);
        return;
      }
      setLlmLoading(true);
      setLlmError(null);
      setLlmSuggestion(null);
      close();
      try {
        const res = await fetch(`/api/notebooks/${options.notebookId}/ai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request: userQuery.slice(0, 500) }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok: boolean;
          data?: { code: string; explanation: string };
          error?: { message?: string };
        } | null;
        if (seq !== requestSeq.current) return;
        if (!res.ok || !data?.ok || !data.data?.code) {
          setLlmError(data?.error?.message ?? "The assistant could not answer. Try a different phrasing.");
          return;
        }
        setLlmSuggestion({ code: data.data.code, explanation: data.data.explanation });
      } catch {
        if (seq === requestSeq.current) {
          setLlmError("The assistant is unavailable right now. Try again in a moment.");
        }
      } finally {
        if (seq === requestSeq.current) setLlmLoading(false);
      }
    },
    [options.notebookId, close],
  );

  const clearLlm = useCallback(() => {
    setLlmSuggestion(null);
    setLlmError(null);
    setLlmLoading(false);
  }, []);

  return {
    suggestions,
    isVisible,
    highlightedIndex,
    llmLoading,
    llmError,
    llmSuggestion,
    filterSuggestions,
    close,
    setSuggestions,
    setIsVisible,
    setHighlightedIndex,
    triggerLlm,
    clearLlm,
  };
}
