/**
 * Shared helpers for the Prompt API (variable extraction + serialization).
 * Lives in lib/server so both /api/prompts routes can import it without
 * coupling one route file to another.
 */
import { parseJsonArray } from "@/lib/json";
import type { PromptItem } from "@/lib/types";

/** Extract unique {{variable}} tokens from a prompt template. */
export function extractVariables(template: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const name = (m[1] as string).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function toItem(p: {
  id: string;
  name: string;
  description: string | null;
  template: string;
  variables: string;
  chain: string;
  isAdvisorTemplate: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PromptItem {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    template: p.template,
    variables: parseJsonArray<string>(p.variables, []),
    chain: parseJsonArray<string>(p.chain, []),
    isAdvisorTemplate: p.isAdvisorTemplate,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
