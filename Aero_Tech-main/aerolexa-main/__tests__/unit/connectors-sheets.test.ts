/**
 * Unit tests for the Google Sheets connector engine
 * (lib/engine/connectors/sheets.ts) + config validation.
 *
 * The HTTP layer is mocked at `fetch` so the real auth wiring, error mapping,
 * header/type inference, paste-down semantics and truncation are all exercised
 * without network access.
 */

import { generateKeyPairSync } from "node:crypto";

import { validateConnectorConfig } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { SHEETS_LIMITS, fetchSheetsRows, headerColumnsFromRows } from "@/lib/engine/connectors/sheets";

// A real, parseable PKCS#8 RSA key so the auth path (normalizePrivateKey + jose
// signing) is exercised for real — no network needed for that part.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const CREDENTIALS = JSON.stringify({
  client_email: "sa@aerolexa.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
});

const validConfig = { spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74", credentialsJson: CREDENTIALS };

/** The parsed inner config the pull dispatcher passes to the engine. */
const parsedConfig = validateConnectorConfig("sheets", validConfig).sheets;

/**
 * Mock fetch for the whole auth+pull chain: the token endpoint gets a real
 * JWT assertion POST (and answers with an access_token); every sheets.googleapis
 * .com call returns `payload` with `status`.
 */
function mockSheetsApi(payload: unknown, status = 200) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const mockFetchOnce = mockSheetsApi;

afterEach(() => {
  jest.restoreAllMocks();
});

describe("sheets config validation", () => {
  it("accepts a valid config and validates through the shared dispatcher", () => {
    const cfg = validateConnectorConfig("sheets", validConfig);
    expect(cfg.kind).toBe("sheets");
    if (cfg.kind === "sheets") {
      expect(cfg.sheets.spreadsheetId).toBe(validConfig.spreadsheetId);
      expect(JSON.parse(cfg.sheets.credentialsJson)).toHaveProperty("client_email");
    }
  });

  it("rejects a URL pasted instead of the spreadsheet ID", () => {
    expect(() =>
      validateConnectorConfig("sheets", {
        ...validConfig,
        spreadsheetId: "https://docs.google.com/spreadsheets/d/ABC/edit",
      }),
    ).toThrow(ConnectorError);
  });

  it("rejects credentials JSON without client_email/private_key", () => {
    expect(() =>
      validateConnectorConfig("sheets", { spreadsheetId: validConfig.spreadsheetId, credentialsJson: "{}" }),
    ).toThrow(/client_email and private_key/);
  });
});

describe("headerColumnsFromRows", () => {
  it("infers number/string types from real values and fills blank headers", () => {
    const cols = headerColumnsFromRows([
      ["Region", "", 42],
      ["East", 1.5, 7],
      ["West", "x", 8],
    ]);
    expect(cols[0]).toEqual({ name: "Region", dataType: "string", nullable: true });
    expect(cols[1]).toEqual({ name: "Column 2", dataType: "string", nullable: true });
    expect(cols[2]).toEqual({ name: "42", dataType: "number", nullable: true });
  });

  it("returns [] for an empty grid", () => {
    expect(headerColumnsFromRows([])).toEqual([]);
  });
});

describe("fetchSheetsRows", () => {
  it("pulls rows pasted down, types columns, caps with honest truncation", async () => {
    mockFetchOnce({
      values: [
        ["date", "region", "revenue", "active"],
        ["2026-01-01", "East", 100, true],
        ["2026-01-02", "West", 200.5, false],
        ["2026-01-03", "East", null, null],
        ["2026-01-04", "North", 50, true],
      ],
    });

    const pulled = await fetchSheetsRows(parsedConfig, "Sales", 3);

    expect(pulled.totalRows).toBe(4);
    expect(pulled.truncated).toBe(true);
    expect(pulled.rows).toHaveLength(3);
    expect(pulled.rows[0]).toEqual(["2026-01-01", "East", 100, true]);
    expect(pulled.rows[2]).toEqual(["2026-01-03", "East", null, null]);
    const revenue = pulled.columns.find((c) => c.name === "revenue");
    expect(revenue?.type).toBe("number");
    const active = pulled.columns.find((c) => c.name === "active");
    expect(active?.type).toBe("boolean");
  });

  it("sends the whole-tab A1 range with UNFORMATTED_VALUE rendering", async () => {
    const fetchMock = mockFetchOnce({ values: [["h"], [1]] });
    await fetchSheetsRows(parsedConfig, "My Tab", 10);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain("/values/");
    expect(decodeURIComponent(calledUrl)).toContain("'My Tab'");
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("authorization")).toMatch(/^Bearer /);
  });

  it("maps a PERMISSION_DENIED 403 to the share-the-sheet remedy", async () => {
    mockFetchOnce({ error: { message: "The caller does not have permission" } }, 403);
    await expect(fetchSheetsRows(parsedConfig, "S", 5)).rejects.toThrow(/Share → add the service account/);
  });

  it("maps a 404 to the spreadsheet-not-found remedy", async () => {
    mockFetchOnce({ error: { message: "Requested entity was not found." } }, 404);
    await expect(fetchSheetsRows(parsedConfig, "S", 5)).rejects.toThrow(/spreadsheet was not found/);
  });

  it("maps a 401 to the credential remedy without echoing the key", async () => {
    mockFetchOnce({ error: { message: "Invalid Credentials" } }, 401);
    await expect(fetchSheetsRows(parsedConfig, "S", 5)).rejects.toThrow(/service-account token/);
  });

  it("rejects an empty tab with a readable error", async () => {
    mockFetchOnce({});
    await expect(fetchSheetsRows(parsedConfig, "Empty", 5)).rejects.toThrow(/is empty/);
  });
});

describe("sheets limits", () => {
  it("exposes the documented cell/width caps", () => {
    expect(SHEETS_LIMITS.MAX_CELLS).toBe(2_000_000);
    expect(SHEETS_LIMITS.MAX_COLUMNS).toBe(702);
  });
});
