/**
 * Web search backend selection + parsing. Env is read lazily from process.env
 * and cached at module level, so each scenario re-imports the module fresh
 * with `jest.resetModules()` to control which backend `searchWeb` uses.
 */

type FetchMock = jest.MockedFunction<typeof fetch>;

describe("web search — Google Custom Search path", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
    process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
    process.env.GOOGLE_CSE_API_KEY = "test-key";
    process.env.GOOGLE_CSE_ENGINE_ID = "test-cx";
    delete process.env.SEARCH_RESULT_LIMIT;
  });

  it("returns results parsed from the Google JSON API", async () => {
    const { searchWeb, webSearchUsesGoogle } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { title: "  ARM  Chips  ", link: "https://example.com/arm", snippet: "Latest ARM announcements…" },
          { title: "Another result", link: "https://example.com/two", snippet: "<b>Bold</b> snippet" },
          { link: "https://example.com/no-title" },
        ],
      }),
    });

    const results = await searchWeb("latest ARM chips 2026");
    expect(webSearchUsesGoogle()).toBe(true);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "ARM Chips",
      url: "https://example.com/arm",
      snippet: "Latest ARM announcements…",
    });
    expect((global.fetch as unknown as FetchMock).mock.calls[0]?.[0]).toMatch(
      /https:\/\/www\.googleapis\.com\/customsearch\/v1\?/,
    );
  });

  it("trims a query's title to a bounded length", async () => {
    const { searchWeb } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ title: "x".repeat(500), link: "https://example.com/long", snippet: "" }],
      }),
    });

    const results = await searchWeb("long title");
    expect(results[0]!.title.length).toBeLessThanOrEqual(200);
  });

  it("never throws when the provider errors — degrades to []", async () => {
    const { searchWeb } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockRejectedValue(new Error("network down"));
    await expect(searchWeb("anything")).resolves.toEqual([]);
  });
});

describe("web search — DuckDuckGo fallback (free, no keys)", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
    process.env.AUTH_SECRET = "test-secret-0123456789abcdef";
    process.env.GOOGLE_CSE_API_KEY = "";
    process.env.GOOGLE_CSE_ENGINE_ID = "";
    delete process.env.SEARCH_RESULT_LIMIT;
  });

  const html = `
    <div class="result">
      <div class="result__body">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">A &amp; B Guide</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">The best <b>guide</b> ever.</a>
      </div>
      <div class="result__body">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo&amp;rut=xyz">Second result</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo&amp;rut=xyz">Another snippet.</a>
      </div>
    </div>
  `;

  it("uses DuckDuckGo when no Google keys are configured", async () => {
    const { searchWeb, webSearchUsesGoogle } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const results = await searchWeb("what is a pivot table");
    expect(webSearchUsesGoogle()).toBe(false);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "A & B Guide",
      url: "https://example.com/guide",
      snippet: "The best guide ever.",
    });
    expect(results[1]!.url).toBe("https://example.com/two");
  });

  it("limits results to the configured cap", async () => {
    process.env.SEARCH_RESULT_LIMIT = "1";
    const { searchWeb } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const results = await searchWeb("capped");
    expect(results).toHaveLength(1);
  });

  it("degrades to [] on a failed duckduckgo response", async () => {
    const { searchWeb } = await import("@/lib/web/search");
    (global.fetch as unknown as FetchMock) = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(searchWeb("down")).resolves.toEqual([]);
  });
});
