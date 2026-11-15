import { stringifyJson, parseJson, parseJsonArray, safeJsonStringify } from "@/lib/json";

describe("json persistence helpers", () => {
  it("round-trips nested objects", () => {
    const payload = { a: 1, nested: { list: [1, "two", null] }, ok: true };
    const raw = stringifyJson(payload);
    expect(parseJson<typeof payload>(raw, { a: 0, nested: { list: [] }, ok: false })).toEqual(payload);
  });

  it("falls back on empty or invalid input", () => {
    const fallback = { fallback: true };
    expect(parseJson(null, fallback)).toBe(fallback);
    expect(parseJson(undefined, fallback)).toBe(fallback);
    expect(parseJson("", fallback)).toBe(fallback);
    expect(parseJson("{not valid json", fallback)).toBe(fallback);
  });

  it("only accepts arrays for parseJsonArray", () => {
    expect(parseJsonArray<string>('["a","b"]', ["x"])).toEqual(["a", "b"]);
    expect(parseJsonArray<string>('{"a":1}', ["x"])).toEqual(["x"]);
    expect(parseJsonArray<string>(null)).toEqual([]);
    expect(parseJsonArray<string>(undefined)).toEqual([]);
  });

  it("safeJsonStringify returns null for circular input", () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    expect(safeJsonStringify(circular)).toBeNull();
    expect(safeJsonStringify({ fine: 1 })).toBe('{"fine":1}');
  });
});
