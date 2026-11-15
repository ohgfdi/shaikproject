import { parseAgentAction } from "@/lib/copilot/agent-protocol";

/**
 * The parser is the enforcement point of the agent protocol: only a well-formed
 * single JSON object may ever become a tool call. Local models are chatty, so
 * the parser tolerates formatting but never guesses intent.
 */

describe("copilot protocol — parseAgentAction", () => {
  it("parses a plain tool call", () => {
    const action = parseAgentAction('{"tool":"get_schema","args":{}}');
    expect(action).toEqual({ kind: "tool", tool: "get_schema", args: {} });
  });

  it("parses a fenced JSON block", () => {
    const action = parseAgentAction('```json\n{"tool":"compute_metrics","args":{"ids":["revenue_total"]}}\n```');
    expect(action.kind).toBe("tool");
    if (action.kind === "tool") {
      expect(action.tool).toBe("compute_metrics");
      expect(action.args.ids).toEqual(["revenue_total"]);
    }
  });

  it("ignores a leading sentence around the object", () => {
    const action = parseAgentAction(
      'Sure! Here is my action: {"tool":"finish","args":{"summary":"done"}} — hope that helps',
    );
    expect(action.kind).toBe("tool");
    if (action.kind === "tool") expect(action.tool).toBe("finish");
  });

  it("defaults args to an empty object when omitted or malformed", () => {
    const noArgs = parseAgentAction('{"tool":"get_schema"}');
    expect(noArgs.kind === "tool" && noArgs.args).toEqual({});
    const badArgs = parseAgentAction('{"tool":"get_schema","args":"oops"}');
    expect(badArgs.kind === "tool" && badArgs.args).toEqual({});
  });

  it("rejects prose with no JSON", () => {
    const action = parseAgentAction("I cannot help with that.");
    expect(action.kind).toBe("invalid");
  });

  it("rejects malformed JSON", () => {
    const action = parseAgentAction('{"tool":"get_schema",}');
    expect(action.kind).toBe("invalid");
  });

  it("rejects a JSON object with no tool field", () => {
    const action = parseAgentAction('{"summary":"hello"}');
    expect(action.kind).toBe("invalid");
    if (action.kind === "invalid") expect(action.reason).toMatch(/tool/);
  });

  it("rejects an array response", () => {
    const action = parseAgentAction('[{"tool":"get_schema"}]');
    expect(action.kind).toBe("invalid");
  });
});
