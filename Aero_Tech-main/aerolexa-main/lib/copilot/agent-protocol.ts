/**
 * Agent action protocol — provider-agnostic by design.
 *
 * The agent speaks a tiny, strictly parsed JSON protocol rather than depending
 * on native function-calling wire shapes. The model answers each turn with
 * exactly one object,
 * either a tool call or a `finish`. That keeps the agent honest and portable —
 * and the parser is the enforcement point, so malformed output can never be
 * mistaken for a tool call.
 *
 *   {"tool":"get_schema","args":{}}
 *   {"tool":"compute_metrics","args":{"ids":["revenue_total"]}}
 *   {"tool":"run_analysis","args":{"kind":"trend","metric":"revenue","dateCol":"date","granularity":"month"}}
 *   {"tool":"finish","args":{"summary":"Revenue totalled $1,234.56 across 90% of rows."}}
 */

import { TOOL_SPECS } from "@/lib/copilot/tools";

export type AgentAction =
  { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "invalid"; reason: string; raw: string };

/** Strip markdown fences and surrounding prose, then parse the JSON object. */
export function parseAgentAction(content: string): AgentAction {
  const raw = content.trim();
  if (!raw) return { kind: "invalid", reason: "The model returned an empty response.", raw };

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1]! : raw).trim();

  // An array is never a valid single action. Reject before the {} extraction
  // below would happily pull the first element out of it and call it a tool.
  if (body.startsWith("[")) {
    return { kind: "invalid", reason: "The response was a JSON array, not a single object.", raw: body.slice(0, 400) };
  }

  // Tolerate a leading sentence: take the outermost {...} span.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { kind: "invalid", reason: "The response contained no JSON object.", raw: body.slice(0, 400) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { kind: "invalid", reason: "The response was not valid JSON.", raw: body.slice(0, 400) };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "The response was not a JSON object.", raw: body.slice(0, 400) };
  }

  const obj = parsed as Record<string, unknown>;
  const tool = obj.tool;
  if (typeof tool !== "string" || !tool.trim()) {
    return { kind: "invalid", reason: 'The JSON object had no "tool" field.', raw: body.slice(0, 400) };
  }

  const argsRaw = obj.args;
  const args =
    typeof argsRaw === "object" && argsRaw !== null && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};

  return { kind: "tool", tool: tool.trim(), args };
}

function toolCatalog(): string {
  return TOOL_SPECS.map((spec) => {
    const args = Object.entries(spec.args);
    const argLines = args.length
      ? args.map(([name, desc]) => `      - ${name}: ${desc}`).join("\n")
      : "      (no arguments)";
    const required = spec.required.length ? `required: ${spec.required.join(", ")}` : "required: none";
    return `  * ${spec.name} — ${spec.description}\n    arguments:\n${argLines}\n    ${required}`;
  }).join("\n\n");
}

/**
 * The system prompt. It is deliberately blunt about the honesty contract: the
 * model may only compute through tools, and its prose is verified against tool
 * output afterwards. This is a contract the runtime enforces, not a request.
 */
export function buildAgentSystemPrompt(schemaSummary: string): string {
  return `You are Ledgerly's data copilot. You help a user understand ONE real dataset.

You have NO knowledge of the data beyond what the tools return. You must not use prior knowledge, and you must never guess, estimate or invent a value.

Available tools:
${toolCatalog()}

Dataset facts you already have:
${schemaSummary}

RESPONSE FORMAT (strict):
- Reply with exactly ONE JSON object and nothing else. No prose outside the JSON, no markdown fences.
- To call a tool: {"tool":"<name>","args":{...}}
- To answer the user: {"tool":"finish","args":{"summary":"<your summary>"}}

RULES:
0. Greetings, thanks and identity questions ("hi", "who are you") need NO tool: call "finish" immediately with a warm one-or-two-sentence reply in plain language. Keep it short and do not state any number.
1. Prefer using a tool over answering from memory. If you have not called a tool that computes what the user asked for, call one now.
2. Use exact column names from the dataset. Never invent a column.
3. In "summary", write one or two plain sentences. You may ONLY state numbers that appeared in a tool result. Every number you write is checked against tool output; if it cannot be verified the entire summary is discarded and the user is told so. Copy numbers verbatim (e.g. "$1,234.56"), do not round, convert or compute new ones.
4. If a tool fails, read its error, fix the arguments and try again. Do not fabricate a result.
5. If the data genuinely cannot answer the question, call "finish" and say so plainly, and say what would be needed.`;
}

/**
 * A1 addendum — appended to the system prompt when the copilot is bound to a
 * dashboard page. Advertises get_dashboard_context and teaches the filtering
 * rule: explain the page AS FILTERED by re-running the widgets' analyses with
 * the active cross-filters applied.
 */
export function buildDashboardPromptAddendum(): string {
  return `

DASHBOARD CONTEXT:
This conversation is bound to a dashboard page the user is LOOKING AT right now.
An extra tool is available:
  * get_dashboard_context — returns the page's widget titles/types, the saved
    analysis config behind each widget, and the cross-filter selections the
    user has applied on the canvas.
    arguments:
      (no arguments)

RULES for dashboard questions ("why is this flat?", "explain this page", "what
about the filtered view?"):
D1. Call get_dashboard_context FIRST — before any other tool — whenever the
    question mentions this page, a widget, or a filter.
D2. To compute a widget's numbers, re-run its analysis: same kind, same
columns as the saved config, plus filterCol/filterValue copied from the
active cross-filters. That reproduces exactly what is on screen.
D3. The widget metadata contains NO numbers. Never quote a value from it —
compute everything with run_analysis or compute_metrics as usual.`;
}

/** The running transcript handed to the model on each turn. */
export function buildAgentTurnPrompt(request: string, transcript: string): string {
  return [
    `User request: ${request}`,
    "",
    transcript
      ? `Transcript so far:\n${transcript}\n\nWhat is your next single JSON action?`
      : "You have not called any tool yet. What is your first single JSON action?",
  ].join("\n");
}

/** Render one tool execution into transcript lines the model can reason over. */
export function renderToolResult(tool: string, ok: boolean, digest: string, error?: string): string {
  if (ok) {
    return `RESULT of ${tool}():\n${digest}`;
  }
  return `ERROR from ${tool}(): ${error ?? "unknown error"}`;
}
