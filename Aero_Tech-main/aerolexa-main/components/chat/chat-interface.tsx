"use client";

import { Bot, Check, Copy, Globe, History, Plus, Send, Square, Trash2, User as UserIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import type { ChatSource } from "@/lib/chat/engine";
import type { ChatModelOption } from "@/lib/llm/providers";
import { cn } from "@/lib/utils";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  searching?: boolean;
  searchText?: string;
  error?: string;
  streaming?: boolean;
  model?: string;
}

interface SsePayload {
  event: string;
  data: string;
}

/** Shape of GET /api/llm/status — the deployment's honest copilot config. */
interface LlmStatus {
  configured: boolean;
  reachable: boolean;
  provider: "anthropic";
  model: string;
  source: string;
  hint?: string | null;
}

/** Shape of GET /api/search/status — which web backend is answering. */
interface SearchStatus {
  backend: "google" | "duckduckgo";
  hint?: string | null;
}

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  webSearch: boolean;
  model: string | null;
  messageCount: number;
  preview: string;
}

const SUGGESTIONS = [
  "What are the best charts for time-series data?",
  "Search the web: latest data analytics trends in 2026",
  "Draft an executive summary template for a sales report",
  "How do I reduce churn? Give me a data-driven plan",
];

/**
 * Quick actions are real destinations, not prompts. The Copilot has no client-
 * books tools yet, so pretending it could reconcile GST from this box would be
 * a fake capability; sending the user to the workspace that can is honest.
 */
const QUICK_LINKS = [
  { href: "/books", label: "Open client books" },
  { href: "/ca-sources", label: "Import client data" },
  { href: "/ca-compute", label: "Compute client tax" },
];

let uid = 0;
const nextId = () => `m${++uid}`;

export function ChatInterface() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [webSearch, setWebSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ChatSummary[]>([]);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void refreshConfig();
    void refreshHistory();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const canSend = input.trim().length > 0 && !busy;

  async function refreshConfig() {
    try {
      const res = await fetch("/api/chat/config");
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { models?: ChatModelOption[]; default?: string } };
      const list = body.data?.models ?? [];
      setModels(list);
      setModelId((prev) => prev ?? body.data?.default ?? null);
    } catch {
      /* config is cosmetic — skip silently */
    }
    try {
      const res = await fetch("/api/llm/status");
      if (!res.ok) return;
      const body = (await res.json()) as { data?: LlmStatus };
      if (body.data) setLlmStatus(body.data);
    } catch {
      /* status is advisory — skip silently */
    }
    try {
      const res = await fetch("/api/search/status");
      if (!res.ok) return;
      const body = (await res.json()) as { data?: SearchStatus };
      if (body.data) setSearchStatus(body.data);
    } catch {
      /* search backend is advisory — skip silently */
    }
  }

  async function refreshHistory() {
    try {
      const res = await fetch("/api/chat");
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { chats?: ChatSummary[] } };
      setConversations(body.data?.chats ?? []);
    } catch {
      /* history refresh is best-effort */
    }
  }

  async function send(text: string) {
    const request = text.trim();
    if (!request || busy) return;

    const history: UiMessage[] = [...messages, { id: nextId(), role: "user", content: request }];
    setMessages(history);
    setInput("");
    setBusy(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const assistant: UiMessage = {
      id: nextId(),
      role: "assistant",
      content: "",
      searching: webSearch,
      streaming: true,
    };
    setMessages([...history, assistant]);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (fn: (m: UiMessage) => UiMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === assistant.id ? fn(m) : m)));
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: request,
          conversationId: conversationId ?? undefined,
          webSearch,
          model: modelId ?? undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let message = `Request failed (${res.status}).`;
        try {
          const envelope = (await res.json()) as { error?: { message?: string } };
          message = envelope.error?.message ?? message;
        } catch {
          /* keep default message */
        }
        throw new Error(message);
      }
      if (!res.body) throw new Error("The response had no body.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const drain = (raw: string) => {
        for (const block of raw.split("\n\n")) {
          for (const evt of parseSse(block)) handleEvent(evt, patch);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const evt of parseSse(block)) handleEvent(evt, patch);
        }
      }
      if (buffer.trim()) drain(buffer);
      patch((m) => ({ ...m, streaming: false, searching: false }));
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        patch((m) => ({ ...m, streaming: false, searching: false }));
      } else {
        const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
        patch((m) => ({ ...m, streaming: false, searching: false, error: message }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      void refreshHistory();
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function handleEvent(evt: SsePayload, patch: (fn: (m: UiMessage) => UiMessage) => void) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (evt.event) {
      case "conversation": {
        if (typeof data.id === "string" && data.id) {
          setConversationId(data.id);
          if (typeof data.title === "string") setConversationTitle(data.title);
          if (data.created !== true) setNotice(null);
        }
        break;
      }
      case "search": {
        const queries = Array.isArray(data.queries) ? (data.queries as string[]).filter(Boolean) : [];
        patch((m) => ({
          ...m,
          searching: true,
          searchText: queries.length > 0 ? `Searching: ${queries.join(" · ")}` : undefined,
        }));
        break;
      }
      case "sources": {
        const used = data.used === true;
        const sources = Array.isArray(data.sources)
          ? (data.sources as ChatSource[]).filter((s) => typeof s.url === "string")
          : [];
        const queries = Array.isArray(data.queries) ? (data.queries as string[]).length : 0;
        patch((m) => ({ ...m, sources, searching: used && queries > 0 ? false : m.searching }));
        break;
      }
      case "delta": {
        const text = typeof data.text === "string" ? data.text : "";
        if (text) patch((m) => ({ ...m, content: m.content + text, searching: false }));
        break;
      }
      case "done": {
        const model = typeof data.model === "string" ? data.model : undefined;
        patch((m) => ({ ...m, streaming: false, searching: false, model: model ?? m.model }));
        break;
      }
      case "error": {
        const message = typeof data.message === "string" ? data.message : "The model failed mid-stream.";
        patch((m) => ({ ...m, error: message, searching: false, streaming: false }));
        break;
      }
      default:
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setConversationId(null);
    setConversationTitle(null);
    setBusy(false);
    setNotice(null);
  }

  async function openConversation(id: string) {
    if (busy || id === conversationId) return;
    abortRef.current?.abort();
    try {
      const res = await fetch(`/api/chat/${id}`);
      const body = (await res.json()) as {
        ok?: boolean;
        data?: {
          id: string;
          title: string;
          webSearch: boolean;
          model: string | null;
          messages: { role: string; content: string; sources?: ChatSource[] }[];
        };
      };
      if (!res.ok || !body?.ok || !body.data) {
        if (res.status === 404) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
        }
        return;
      }
      const d = body.data;
      setConversationId(d.id);
      setConversationTitle(d.title);
      setWebSearch(d.webSearch);
      const knownModel = d.model && models.some((m) => m.id === d.model) ? d.model : null;
      if (knownModel) setModelId(knownModel);
      setMessages(
        d.messages.map((m) => ({
          id: nextId(),
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          sources: m.sources,
        })),
      );
      setHistoryOpen(false);
    } catch {
      setNotice("Could not load that conversation.");
    }
  }

  async function deleteConversation(id: string) {
    try {
      await fetch(`/api/chat/${id}`, { method: "DELETE" });
    } catch {
      /* keep going — refresh below will restore if it failed */
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) newChat();
  }

  function modelLabel(id: string | null | undefined): string {
    if (!id) return "";
    return models.find((m) => m.id === id)?.label ?? id;
  }

  const sources = useMemo(() => messages.flatMap((m) => m.sources ?? []), [messages]);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 lg:flex-row">
      {/* History sidebar */}
      <aside
        className={cn(
          "max-h-[40dvh] w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface/60 lg:flex lg:max-h-none lg:w-64",
          historyOpen ? "flex" : "hidden",
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-caption font-semibold text-foreground">
            <History className="size-3.5 text-accent" />
            Conversations
          </span>
          <Button variant="ghost" size="sm" onClick={newChat} className="lg:hidden">
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="px-3 py-4 text-caption text-muted">Your conversations will appear here.</p>
          ) : (
            <ul className="space-y-1 p-2">
              {conversations.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => void openConversation(c.id)}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                      c.id === conversationId ? "bg-accent/10" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-foreground">{c.title}</span>
                    <span className="mt-0.5 block truncate text-caption text-muted">{c.preview}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.title}`}
                    onClick={() => void deleteConversation(c.id)}
                    className="absolute right-1 top-1 hidden rounded-md p-1 text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2 hover:text-foreground group-hover:block"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Chat column */}
      <main className="flex h-full min-w-0 flex-1 flex-col justify-center">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
          {/* Header */}
          <div className="flex items-center justify-between pb-3">
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
                <Bot className="size-5 text-accent" />
                Copilot
              </h1>
              <p className="mt-0.5 text-caption text-muted">
                {conversationTitle
                  ? `Conversation: ${conversationTitle}`
                  : "ChatGPT-style assistant with optional live web search. Answers stream as they are generated."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {searchStatus && (
                <span
                  title={searchStatus.hint ?? "Live web search backend"}
                  className="hidden items-center gap-1 rounded-full border border-line px-2.5 py-1 text-caption text-muted sm:inline-flex"
                >
                  <Globe
                    className={cn("size-3.5", searchStatus.backend === "google" ? "text-accent" : "text-muted/60")}
                  />
                  {searchStatus.backend === "google" ? "Google connected" : "Web search (DuckDuckGo)"}
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setHistoryOpen((v) => !v)}
                className="lg:hidden"
                icon={<History className="size-4" />}
              >
                History
              </Button>
              <Button variant="secondary" size="sm" onClick={newChat} icon={<Plus className="size-4" />}>
                New chat
              </Button>
            </div>
          </div>

          {notice && (
            <p className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">{notice}</p>
          )}

          {/* Honest setup status: what answers today, and the one-variable fix. */}
          {llmStatus && (!llmStatus.reachable || !llmStatus.configured) && (
            <div
              role="status"
              className="mb-3 flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {llmStatus.configured
                    ? `Model configured: Claude · ${llmStatus.model} — not reachable right now.`
                    : "No AI model is configured on this deployment."}
                </p>
                <p className="mt-0.5 text-caption text-muted">
                  {llmStatus.hint ??
                    "Answers still come from the deterministic engine — computed, never hallucinated. To enable live model answers, set a Claude API key in the server environment."}
                </p>
              </div>
            </div>
          )}

          {/* Empty state */}
          {messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/10">
                <Bot className="size-7 text-accent" />
              </div>
              <div className="max-w-md">
                <h2 className="text-lg font-semibold text-foreground">How can I help today?</h2>
                <p className="mt-1 text-sm text-muted">
                  Ask anything — I can also search the live web via Google when you turn it on.
                </p>
              </div>
              <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-xl border border-line bg-surface p-3 text-left text-sm text-muted transition-colors hover:border-accent hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="text-caption text-muted">Client work:</span>
                {QUICK_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded-full border border-line px-3 py-1 text-caption text-muted transition-colors hover:border-accent hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.length > 0 && (
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} modelLabel={m.model ? modelLabel(m.model) : undefined} />
              ))}
            </div>
          )}

          {/* Composer */}
          <div className="sticky bottom-0 border-t border-line bg-background/90 pb-4 pt-3 backdrop-blur">
            {sources.length > 0 && (
              <p className="mb-2 text-caption text-muted">
                {sources.length} web source{sources.length === 1 ? "" : "s"} cited this chat · open them below each
                answer.
              </p>
            )}
            <div className="rounded-2xl border border-line bg-surface shadow-sm focus-within:border-accent">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) void send(input);
                  }
                }}
                rows={1}
                placeholder="Ask the copilot anything…  (Enter to send, Shift+Enter for a new line)"
                aria-label="Message"
                className="max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 text-sm text-foreground outline-none placeholder:text-muted"
              />
              <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer select-none items-center gap-1.5 text-caption text-muted">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={webSearch}
                      onClick={() => setWebSearch((v) => !v)}
                      className={cn(
                        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                        webSearch ? "bg-accent" : "bg-surface-2 border border-line",
                      )}
                    >
                      <span
                        className={cn(
                          // The knob sits on a colored track (accent when on,
                          // surface-2 when off) — a hardcoded white stays
                          // legible on both, and a token colour would lose
                          // contrast against the light accent.
                          "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
                          webSearch ? "translate-x-[18px]" : "translate-x-1",
                        )}
                      />
                    </button>
                    <Globe className="size-3.5" />
                    Search the web
                  </label>

                  {models.length > 0 && (
                    <select
                      value={modelId ?? ""}
                      onChange={(e) => setModelId(e.target.value || null)}
                      disabled={busy}
                      aria-label="Model"
                      className="max-w-[220px] rounded-lg border border-line bg-surface-2 px-2 py-1 text-caption text-foreground outline-none focus:border-accent disabled:opacity-50"
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.default ? " (default)" : ""}
                          {m.reachable ? "" : " (offline)"}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {busy ? (
                  <Button variant="secondary" size="sm" onClick={stop} icon={<Square className="size-3.5" />}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void send(input)}
                    disabled={!canSend}
                    icon={<Send className="size-3.5" />}
                  >
                    Send
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-center text-caption text-muted">
              Copilot can make mistakes. Web results come from live search and are cited with their real URLs.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ message, modelLabel }: { message: UiMessage; modelLabel?: string }) {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <div className="flex items-start justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-on-accent">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2">
          <UserIcon className="size-3.5 text-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/10">
        <Bot className="size-3.5 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        {message.searching && !message.content && (
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
            <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
            {message.searchText ?? "Searching the web…"}
          </div>
        )}

        {message.sources && message.sources.length > 0 && (
          <div className="mb-2 mt-1 space-y-1.5">
            {message.sources.map((s, i) => (
              <a
                key={`${s.url}-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-lg border border-line bg-surface p-2.5 transition-colors hover:border-accent"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Globe className="size-3.5 shrink-0 text-accent" />
                  <span className="truncate">{s.title}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 text-caption text-muted">{s.snippet}</span>
              </a>
            ))}
          </div>
        )}

        {message.content ? (
          <div className="rounded-2xl rounded-bl-md border border-line bg-surface p-4">
            <Markdown text={message.content} sources={message.sources} />
            {modelLabel && !message.streaming && !message.error && (
              <p className="mt-2 border-t border-line pt-2 text-caption text-muted">Answered with {modelLabel}</p>
            )}
          </div>
        ) : null}

        {!message.content && !message.searching && !message.streaming && (
          <div className="flex h-20 items-center gap-2 text-caption text-muted">
            <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
            Generating…
          </div>
        )}

        {message.error && (
          <p className="mt-2 rounded-lg border border-[#E8637A]/30 bg-[#E8637A]/10 p-3 text-sm text-[#B93A52] dark:text-[#F08A9B]">
            {message.error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Fenced code block with a language label and one-click copy — chat answers
 * regularly carry SQL/DAX/DSL snippets the user runs elsewhere.
 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — leave the button as-is.
    }
  };
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-line bg-background">
      <div className="flex items-center justify-between border-b border-line bg-surface px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{language || "code"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy code"}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
            copied
              ? "text-accent"
              : "text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line hover:bg-surface-2 hover:text-foreground",
          )}
        >
          {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Markdown({ text, sources }: { text: string; sources?: ChatSource[] }) {
  return (
    <div className="markdown-body text-sm leading-relaxed text-muted">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const label = Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
            const cite = /^\[\d+\]$/.exec(label.trim());
            const source = cite ? sources?.[Number(cite[0].slice(1, -1)) - 1] : undefined;
            if (cite && source) {
              return (
                <a
                  href={href ?? source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={source.title}
                  className="inline-flex items-center rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent no-underline"
                >
                  {label.trim()}
                </a>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2"
              >
                {children}
              </a>
            );
          },
          code({ className, children, ...props }) {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code className={cn("font-mono text-[13px] text-foreground", className)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-foreground" {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            // react-markdown v10 passes the code element inside `pre`; pull
            // the language + raw text out so the header/copy chrome works.
            const child = Array.isArray(children) ? children[0] : children;
            const className =
              child && typeof child === "object" && "props" in (child as { props?: { className?: string } })
                ? ((child as { props?: { className?: string } }).props?.className ?? "")
                : "";
            const language = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            const raw = flattenText(children);
            return <CodeBlock language={language} code={raw} />;
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-line bg-surface-2 px-2.5 py-1.5 font-semibold text-foreground">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border border-line px-2.5 py-1.5 text-muted">{children}</td>;
          },
          ul({ children }) {
            return <ul className="my-1.5 list-disc pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1.5 list-decimal pl-5">{children}</ol>;
          },
          li({ children }) {
            return <li className="my-0.5">{children}</li>;
          },
          h1({ children }) {
            return <h1 className="mb-1 mt-3 text-lg font-semibold text-foreground">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mb-1 mt-3 text-base font-semibold text-foreground">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mb-1 mt-2 text-sm font-semibold text-foreground">{children}</h3>;
          },
          p({ children }) {
            return <p className="my-1.5 first:mt-0">{children}</p>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Concatenate all text inside a react-markdown children tree. */
function flattenText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  const props = (node as { props?: { children?: React.ReactNode } }).props;
  return flattenText(props?.children);
}

function parseSse(raw: string): SsePayload[] {
  const out: SsePayload[] = [];
  const blocks = raw.split("\n\n");
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}
