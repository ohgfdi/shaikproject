/**
 * Minimal Zod → JSON Schema projection for Anthropic tool definitions.
 *
 * Only the shapes used by the READ tool registry are supported (objects with
 * strings, numbers, booleans, enums, string arrays, optionals and defaults).
 * The Zod schema remains the source of truth for runtime validation; this
 * projection only tells the model what to send. An unsupported shape throws at
 * module load rather than silently advertising a wrong schema.
 */

import { z } from "zod";

type Json = Record<string, unknown>;

function describe(schema: z.ZodTypeAny): Json {
  const description = schema._def.description as string | undefined;
  return description ? { description } : {};
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Json {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToJsonSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodEffects) {
    return zodToJsonSchema(schema.innerType());
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Json = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(child);
      if (!child.isOptional() && !(child instanceof z.ZodDefault)) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
      ...describe(schema),
    };
  }
  if (schema instanceof z.ZodString) {
    const checks = schema._def.checks as Array<{ kind: string; value?: number; regex?: RegExp }>;
    const out: Json = { type: "string", ...describe(schema) };
    for (const check of checks) {
      if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
      if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
      if (check.kind === "regex" && check.regex) out.pattern = check.regex.source;
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const checks = schema._def.checks as Array<{ kind: string; value?: number }>;
    const out: Json = { type: "number", ...describe(schema) };
    for (const check of checks) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min" && typeof check.value === "number") out.minimum = check.value;
      if (check.kind === "max" && typeof check.value === "number") out.maximum = check.value;
      if (check.kind === "multipleOf" && typeof check.value === "number") out.multipleOf = check.value;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean", ...describe(schema) };
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...schema.options], ...describe(schema) };
  }
  if (schema instanceof z.ZodLiteral) {
    return { const: schema.value, ...describe(schema) };
  }
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element), ...describe(schema) };
  }
  throw new Error(`Unsupported Zod schema in assistant tool definition: ${schema.constructor.name}`);
}

export function objectSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict();
}
