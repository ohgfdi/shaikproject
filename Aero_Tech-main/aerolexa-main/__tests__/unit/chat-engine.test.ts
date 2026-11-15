import {
  buildStreamRequest,
  chatSystemPrompt,
  decideSearch,
  gatherWebContext,
  parseSearchQueries,
  renderConversation,
  renderPersonalContext,
  renderWebContext,
  runWebSearches,
  titleForChat,
  type ChatMessage,
} from "@/lib/chat/engine";
import type { LLMProvider } from "@/lib/llm/providers";
import { searchWeb, webSearchUsesGoogle } from "@/lib/web/search";

jest.mock("@/lib/web/search", () => ({
  searchWeb: jest.fn(),
  webSearchUsesGoogle: jest.fn(),
}));

const mockSearchWeb = searchWeb as jest.MockedFunction<typeof searchWeb>;
const mockUsesGoogle = webSearchUsesGoogle as jest.MockedFunction<typeof webSearchUsesGoogle>;

/** A scripted provider whose generate() replays one reply (or throws). */
function scriptedProvider(reply: string | Error): LLMProvider {
  return {
    name: "mock",
    model: "mock-1",
    isAvailable: async () => true,
    async generate() {
      if (reply instanceof Error) throw reply;
      return { content: reply, provider: "mock", model: "mock-1", latencyMs: 1, tokensUsed: 1 };
    },
  };
}

const CONVO: ChatMessage[] = [
  { role: "user", content: "What can you do?" },
  { role: "assistant", content: "I can help with analysis and questions." },
  { role: "user", content: "What is the latest ARM chip announcement?" },
];

describe("chat engine — parseSearchQueries", () => {
  it("parses a bare JSON array", () => {
    expect(parseSearchQueries('["latest ARM chips 2026"]')).toEqual(["latest ARM chips 2026"]);
  });

  it("tolerates prose around the array and multiple queries, capped at 2", () => {
    const content = 'Sure! Here you go: ["a", "b", "c", "d"] hope this helps';
    expect(parseSearchQueries(content)).toEqual(["a", "b"]);
  });

  it("returns [] for junk or an empty array", () => {
    expect(parseSearchQueries("I don't need to search")).toEqual([]);
    expect(parseSearchQueries("[]")).toEqual([]);
    expect(parseSearchQueries("{not json")).toEqual([]);
  });

  it("drops non-string entries and empty strings", () => {
    expect(parseSearchQueries('["ok", 42, null, ""]')).toEqual(["ok"]);
  });
});

describe("chat engine — renderConversation", () => {
  it("labels each side of the conversation", () => {
    const text = renderConversation(CONVO);
    expect(text).toContain("User: What can you do?");
    expect(text).toContain("Assistant: I can help");
    expect(text).toContain("User: What is the latest ARM chip announcement?");
  });
});

describe("chat engine — gatherWebContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stays offline when the router decides web info is not needed", async () => {
    mockSearchWeb.mockResolvedValue([]);
    const ctx = await gatherWebContext(scriptedProvider("[]"), CONVO);
    expect(ctx.used).toBe(false);
    expect(ctx.sources).toEqual([]);
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("runs real searches when the router asks for them", async () => {
    mockUsesGoogle.mockReturnValue(true);
    mockSearchWeb.mockResolvedValue([
      { title: "ARM CPUs", url: "https://example.com/arm", snippet: "Latest announcements" },
      { title: "Chip market", url: "https://example.com/chips", snippet: "Share price" },
    ]);
    const ctx = await gatherWebContext(scriptedProvider('["ARM chips announcements 2026"]'), CONVO);
    expect(ctx.used).toBe(true);
    expect(ctx.backend).toBe("google");
    expect(ctx.queries).toEqual(["ARM chips announcements 2026"]);
    expect(ctx.sources).toHaveLength(2);
    expect(mockSearchWeb).toHaveBeenCalledWith("ARM chips announcements 2026");
  });

  it("parses only a real JSON array out of the router reply", async () => {
    mockUsesGoogle.mockReturnValue(false);
    mockSearchWeb.mockResolvedValue([{ title: "T", url: "https://example.com/r", snippet: "S" }]);
    const ctx = await gatherWebContext(
      scriptedProvider('The web would help. ["docs for Next.js 15 middleware"]'),
      CONVO,
    );
    expect(ctx.used).toBe(true);
    expect(ctx.backend).toBe("duckduckgo");
    expect(ctx.sources[0]!.url).toBe("https://example.com/r");
  });

  it("survives a provider/router failure without using the web", async () => {
    mockSearchWeb.mockResolvedValue([]);
    const ctx = await gatherWebContext(scriptedProvider(new Error("model down")), CONVO);
    expect(ctx.used).toBe(false);
  });
});

describe("chat engine — buildStreamRequest", () => {
  it("injects web results only when web search was used", () => {
    const web = {
      used: true,
      backend: "google" as const,
      queries: ["q"],
      sources: [{ title: "ARM CPU", url: "https://example.com/arm", snippet: "snippet" }],
    };
    const { systemPrompt, userPrompt } = buildStreamRequest(CONVO, web);
    expect(systemPrompt).toContain("Live web search results");
    expect(systemPrompt).toContain("https://example.com/arm");
    expect(systemPrompt).not.toContain("[DONE]");
    expect(userPrompt).toContain("latest ARM chip announcement");
  });

  it("leaves web content out when not used", () => {
    const { systemPrompt } = buildStreamRequest(CONVO, { used: false, backend: "none", queries: [], sources: [] });
    expect(systemPrompt).not.toContain("Live web search results");
  });

  it("renders a truthful 'no results' note when the lookup came up empty", () => {
    expect(renderWebContext({ used: true, backend: "google", queries: ["x"], sources: [] })).toContain(
      "could not find anything online",
    );
  });
});

describe("chat engine — decideSearch + runWebSearches split", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("decideSearch extracts queries but never throws", async () => {
    const queries = await decideSearch(scriptedProvider('["ARM chips 2026"]'), CONVO);
    expect(queries).toEqual(["ARM chips 2026"]);
  });

  it("decideSearch returns [] when the router fails", async () => {
    mockSearchWeb.mockResolvedValue([]);
    expect(await decideSearch(scriptedProvider(new Error("down")), CONVO)).toEqual([]);
  });

  it("runWebSearches is a no-op when no queries were decided", async () => {
    const ctx = await runWebSearches([]);
    expect(ctx.used).toBe(false);
    expect(ctx.backend).toBe("none");
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("runWebSearches runs the real searches and dedupes sources", async () => {
    mockUsesGoogle.mockReturnValue(false);
    mockSearchWeb.mockResolvedValueOnce([
      { title: "ARM", url: "https://example.com/arm/", snippet: "S1" },
      { title: "Chips", url: "https://example.com/chips", snippet: "S2" },
    ]);
    mockSearchWeb.mockResolvedValue([{ title: "ARM again", url: "https://example.com/arm", snippet: "S3" }]);
    const ctx = await runWebSearches(["arm chips", "arm again"]);
    expect(ctx.used).toBe(true);
    expect(ctx.backend).toBe("duckduckgo");
    expect(ctx.queries).toEqual(["arm chips", "arm again"]);
    expect(ctx.sources).toHaveLength(2); // trailing slash + scheme normalisation dedupes
  });

  it("gatherWebContext still works as the decide+run wrapper", async () => {
    mockUsesGoogle.mockReturnValue(true);
    mockSearchWeb.mockResolvedValue([{ title: "T", url: "https://example.com/t", snippet: "S" }]);
    const ctx = await gatherWebContext(scriptedProvider('["q1"]'), CONVO);
    expect(ctx.used).toBe(true);
    expect(ctx.backend).toBe("google");
  });
});

describe("chat engine — personal context + titles", () => {
  it("renderPersonalContext embeds only real workspace facts", () => {
    const text = renderPersonalContext({
      userName: "Ada",
      workspaceName: "Growth Analytics",
      organization: "Acme",
      industry: "SaaS",
      projects: [{ name: "Churn" }],
      datasets: [{ name: "sales.csv", rowCount: 1234, columnCount: 6 }],
    });
    expect(text).toContain("Workspace: Growth Analytics");
    expect(text).toContain("User: Ada (Acme)");
    expect(text).toContain("Industry: SaaS");
    expect(text).toContain("Projects: Churn");
    expect(text).toContain("sales.csv (1,234 rows × 6 columns)");
    expect(text).toContain("You have NOT opened or queried any dataset");
  });

  it("renderPersonalContext returns '' when nothing is known", () => {
    expect(renderPersonalContext({})).toBe("");
  });

  it("chatSystemPrompt includes the rendered context when passed", () => {
    const withCtx = chatSystemPrompt({ workspaceName: "W" });
    expect(withCtx).toContain("Workspace: W");
  });

  it("titleForChat uses the first user message, truncated", () => {
    expect(titleForChat([{ role: "user", content: "hello" }])).toBe("hello");
    expect(
      titleForChat([
        { role: "assistant", content: "hi" },
        { role: "user", content: "x".repeat(80) },
      ]),
    ).toHaveLength(46); // 45 chars + ellipsis
    expect(titleForChat([])).toBe("New chat");
    expect(titleForChat([], "fallback")).toBe("fallback");
  });

  it("buildStreamRequest injects the personal context into the system prompt", () => {
    const { systemPrompt } = buildStreamRequest(
      CONVO,
      { used: false, backend: "none", queries: [], sources: [] },
      { workspaceName: "Acme" },
    );
    expect(systemPrompt).toContain("Workspace: Acme");
  });
});
