"use client";

/**
 * CopilotTextarea — notebook code editor with inline assistance.
 *
 * - Static autocomplete dropdown (DSL commands, columns, pandas methods),
 *   filtered by the token being typed; Tab or Enter inserts.
 * - `/llm <request>` natural-language flow: sends the request to the
 *   notebook AI route and shows the translated code with an explanation;
 *   Tab inserts it in place of the /llm line.
 * - Ctrl/⌘ + Enter runs the cell (same convention as the notebook toolbar).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useNotebookCopilot } from "@/components/notebook/copilot-hook";
import type { SuggestionItem } from "@/components/notebook/copilot-hook";
import { cn } from "@/lib/utils";

export interface CopilotTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  columns?: string[];
  notebookId?: string | null;
  datasetName?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function CopilotTextarea({
  value,
  onChange,
  onRun,
  columns = [],
  notebookId,
  datasetName,
  placeholder,
  ariaLabel,
  disabled,
  className,
}: CopilotTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const llmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copilot = useNotebookCopilot({ datasetColumns: columns, notebookId, datasetName });

  // Keep the editor's view in sync after programmatic inserts.
  const focusAndPlace = useCallback((position: number) => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(position, position);
    setCursor(position);
  }, []);

  /** Token being typed (from the last whitespace before the cursor). */
  const tokenAt = useCallback((text: string, position: number): { token: string; start: number } => {
    const before = text.slice(0, position);
    const match = /([^\s]*)$/.exec(before);
    return { token: match?.[1] ?? "", start: position - (match?.[1]?.length ?? 0) };
  }, []);

  const insertAtCursor = useCallback(
    (insert: string, replaceToken = false) => {
      const el = textareaRef.current;
      const position = el?.selectionStart ?? cursor;
      const { start } = tokenAt(value, position);
      const llmStart = value.slice(0, position).lastIndexOf("/llm");
      const replaceFrom = replaceToken ? start : llmStart >= 0 ? llmStart : position;
      const next = value.slice(0, replaceFrom) + insert + value.slice(position);
      onChange(next);
      copilot.close();
      copilot.clearLlm();
      focusAndPlace(replaceFrom + insert.length);
    },
    [value, cursor, tokenAt, onChange, focusAndPlace, copilot],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const position = e.target.selectionStart ?? next.length;
      onChange(next);
      setCursor(position);

      // Natural-language trigger: /llm <request>
      const before = next.slice(0, position);
      const llmRequest = /\/llm\s+(.+)$/s.exec(before)?.[1]?.trim();
      if (llmRequest && llmRequest.length >= 2) {
        if (llmTimer.current) clearTimeout(llmTimer.current);
        llmTimer.current = setTimeout(() => {
          void copilot.triggerLlm(llmRequest);
        }, 450);
        copilot.close();
        return;
      }
      if (llmTimer.current) {
        clearTimeout(llmTimer.current);
        llmTimer.current = null;
      }

      const { token } = tokenAt(next, position);
      if (token && !token.startsWith("/llm")) {
        copilot.filterSuggestions(token);
      } else {
        copilot.close();
      }
    },
    [onChange, tokenAt, copilot],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const dropdownOpen = copilot.isVisible && copilot.suggestions.length > 0;
      const hasLlm = copilot.llmSuggestion !== null;

      if (e.key === "ArrowDown" && (dropdownOpen || copilot.llmLoading || hasLlm)) {
        e.preventDefault();
        if (dropdownOpen) {
          copilot.setHighlightedIndex((copilot.highlightedIndex + 1) % copilot.suggestions.length);
        }
        return;
      }
      if (e.key === "ArrowUp" && (dropdownOpen || copilot.llmLoading || hasLlm)) {
        e.preventDefault();
        if (dropdownOpen) {
          copilot.setHighlightedIndex(
            (copilot.highlightedIndex - 1 + copilot.suggestions.length) % copilot.suggestions.length,
          );
        }
        return;
      }
      if (e.key === "Tab") {
        if (dropdownOpen) {
          e.preventDefault();
          const item: SuggestionItem | undefined =
            copilot.suggestions[copilot.highlightedIndex] ?? copilot.suggestions[0];
          if (item) insertAtCursor(item.value, true);
        } else if (hasLlm) {
          e.preventDefault();
          insertAtCursor(copilot.llmSuggestion!.code, false);
        }
        return;
      }
      if (e.key === "Enter" && dropdownOpen) {
        e.preventDefault();
        const item: SuggestionItem | undefined =
          copilot.suggestions[copilot.highlightedIndex] ?? copilot.suggestions[0];
        if (item) insertAtCursor(item.value, true);
        return;
      }
      if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Enter" && e.shiftKey)) {
        e.preventDefault();
        onRun?.();
        return;
      }
      if (e.key === "Escape") {
        copilot.close();
        copilot.clearLlm();
      }
    },
    [copilot, insertAtCursor, onRun],
  );

  useEffect(() => {
    return () => {
      if (llmTimer.current) clearTimeout(llmTimer.current);
    };
  }, []);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        spellCheck={false}
        className={cn(
          "min-h-24 w-full resize-y bg-background px-3 py-2 font-mono text-[13px] leading-relaxed focus:outline-none disabled:opacity-60",
          className,
        )}
      />
      {copilot.isVisible && copilot.suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Code suggestions"
          className="absolute left-2 right-2 top-full z-20 mt-0.5 max-h-56 overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
        >
          {copilot.suggestions.map((item, i) => (
            <button
              key={`${item.type}-${item.value}-${i}`}
              type="button"
              role="option"
              aria-selected={i === copilot.highlightedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                insertAtCursor(item.value, true);
              }}
              onMouseEnter={() => copilot.setHighlightedIndex(i)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm",
                i === copilot.highlightedIndex ? "bg-surface-2" : "",
              )}
            >
              <span className="truncate font-mono text-foreground">{item.value}</span>
              <span className="shrink-0 text-caption text-muted">{item.description}</span>
            </button>
          ))}
        </div>
      )}
      {copilot.llmLoading && (
        <div className="absolute left-2 right-2 top-full z-20 mt-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-muted shadow-lg">
          Assistant is translating your request… (Tab to dismiss)
        </div>
      )}
      {copilot.llmError && (
        <div className="absolute left-2 right-2 top-full z-20 mt-0.5 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-sm text-danger shadow-lg">
          {copilot.llmError}
        </div>
      )}
      {copilot.llmSuggestion && (
        <div className="absolute left-2 right-2 top-full z-20 mt-0.5 rounded-md border border-accent/40 bg-surface px-2.5 py-2 shadow-lg">
          <p className="font-mono text-sm text-foreground">{copilot.llmSuggestion.code}</p>
          <p className="mt-1 text-caption text-muted">{copilot.llmSuggestion.explanation}</p>
          <p className="mt-1 text-caption text-accent">Press Tab to insert this code.</p>
        </div>
      )}
    </div>
  );
}
