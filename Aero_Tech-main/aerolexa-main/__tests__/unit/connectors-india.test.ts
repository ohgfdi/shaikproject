/**
 * Oracle tests for the India connectors: live Tally XML gateway + Zoho Books.
 *
 * Pure, hand-computable pieces are asserted directly: request-XML
 * construction, date conversion, XML response parsing, record mapping,
 * config validation, dispatcher registration and SSRF posture. Network
 * paths are exercised against mocked `fetch` so every branch (happy path,
 * OAuth rejection, upstream 5xx, unreachable host, non-XML garbage) is
 * deterministic — the same philosophy as the connectors-http-s3 suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { lookup } from "node:dns/promises";

// Deterministic DNS for the SSRF guard (same pattern as url-guard.test.ts):
// the sandbox has no resolver, so a public hostname would fail closed before
// the (mocked) gateway is reached. Literal-IP hosts bypass DNS entirely, so
// the private-range refusal test still exercises the real guard logic.
jest.mock("node:dns/promises", () => ({
  lookup: jest.fn(),
}));

const mockLookup = lookup as unknown as jest.Mock;

import { validateConnectorConfig, CONNECTOR_KINDS } from "@/lib/engine/connectors/config";
import { ConnectorError } from "@/lib/engine/connectors/errors";
import { CONNECTOR_IMPLEMENTED_KINDS } from "@/lib/engine/connectors/pull";
import {
  buildTallyExportRequest,
  collectTagged,
  fetchTallyGatewayRows,
  fetchTallyGatewayVouchers,
  testTallyGatewayConnection,
  tallyGatewayUrl,
  toTallyDate,
} from "@/lib/engine/connectors/tally";
import {
  ZOHO_BOOKS_TABLES,
  fetchZohoBooksRows,
  mapZohoRecord,
  testZohoBooksConnection,
  zohoBooksTableColumns,
} from "@/lib/engine/connectors/zoho-books";
import { ZOHO_BOOKS_REGIONS, ZOHO_BOOKS_REGION_META } from "@/lib/engine/connectors/zoho-regions";

/** Realistic Tally Day Book XML response (structure per TallyPrime exports). */
const TALLY_DAYBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Export Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
  </DESC>
  <DATA>
   <COLLECTION>
    <VOUCHER>
     <DATE>20250401</DATE>
     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <VOUCHERNUMBER>INV-101</VOUCHERNUMBER>
     <PARTYNAME>Acme Retail</PARTYNAME>
     <PARTYLEDGERNAME>Acme Retail</PARTYLEDGERNAME>
     <NARRATION>April invoice batch</NARRATION>
     <!-- Balanced Tally sales invoice: party debited, sales + CGST credited -->
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Acme Retail</LEDGERNAME>
      <AMOUNT>11800.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Sales - Karnataka</LEDGERNAME>
      <AMOUNT>-10900.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Output CGST</LEDGERNAME>
      <AMOUNT>-900.00</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>
    <VOUCHER>
     <DATE>01-04-2025</DATE>
     <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
     <VOUCHERNUMBER>BILL-77</VOUCHERNUMBER>
     <PARTYLEDGERNAME>Office Supplies Co</PARTYLEDGERNAME>
     <AMOUNT>2360.00</AMOUNT>
    </VOUCHER>
   </COLLECTION>
  </DATA>
 </BODY>
</ENVELOPE>`;

/** Ledger masters response (List of Accounts export). */
const TALLY_LEDGERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <BODY>
  <DATA>
   <COLLECTION>
    <LEDGER>
     <NAME>Sales - Karnataka</NAME>
     <PARENT>Sales Accounts</PARENT>
     <OPENINGBALANCE>0.00</OPENINGBALANCE>
    </LEDGER>
    <LEDGER>
     <NAME>Acme Retail</NAME>
     <PARENT>Sundry Debtors</PARENT>
     <OPENINGBALANCE>45,000.00</OPENINGBALANCE>
    </LEDGER>
   </COLLECTION>
  </DATA>
 </BODY>
</ENVELOPE>`;

/** Install a per-test global fetch mock and restore afterwards. */
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  jest.spyOn(globalThis, "fetch").mockImplementation(impl as typeof fetch);
}

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const XML_RESPONSE = (body: string): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });

describe("connector registry (india)", () => {
  it("registers tally and zoho-books as implemented kinds", () => {
    expect(CONNECTOR_KINDS).toContain("tally");
    expect(CONNECTOR_KINDS).toContain("zoho-books");
    expect(CONNECTOR_IMPLEMENTED_KINDS).toContain("tally");
    expect(CONNECTOR_IMPLEMENTED_KINDS).toContain("zoho-books");
  });

  it("validates a zoho-books config (bare and wrapped shapes)", () => {
    const bare = {
      clientId: "1000.XXXX",
      clientSecret: "secret",
      refreshToken: "1000.yyyy.zzzz",
    };
    const cfg = validateConnectorConfig("zoho-books", bare);
    expect(cfg).toEqual({
      kind: "zoho-books",
      zohoBooks: { ...bare, region: "in", organizationId: "" },
    });
    const wrapped = validateConnectorConfig("zoho-books", { zohoBooks: bare });
    expect(wrapped).toEqual(cfg);
  });

  it("defaults zoho-books region to India", () => {
    const cfg = validateConnectorConfig("zoho-books", {
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    });
    if (cfg.kind !== "zoho-books") throw new Error("expected zoho-books config");
    expect(cfg.zohoBooks.region).toBe("in");
  });

  it("rejects a zoho-books config missing the refresh token", () => {
    expect(() => validateConnectorConfig("zoho-books", { clientId: "c", clientSecret: "s" })).toThrow(
      /Invalid Zoho Books settings/,
    );
  });

  it("tally config stays valid in file-parser mode (host empty) and live mode", () => {
    const fileMode = validateConnectorConfig("tally", { format: "csv" });
    expect(fileMode).toEqual({
      kind: "tally",
      tally: expect.objectContaining({ format: "csv", host: "", port: 9000 }),
    });
    const live = validateConnectorConfig("tally", { host: "tally.example.com", port: 9000 });
    expect(live).toEqual({
      kind: "tally",
      tally: expect.objectContaining({ host: "tally.example.com", port: 9000 }),
    });
  });
});

describe("tally live gateway (pure pieces)", () => {
  const liveConfig = validateConnectorConfig("tally", {
    host: "tally.example.com",
    company: "Acme Pvt Ltd",
    fromDate: "2025-04-01",
    toDate: "2026-03-31",
  });
  if (liveConfig.kind !== "tally") throw new Error("expected tally config");

  it("builds the gateway URL", () => {
    expect(tallyGatewayUrl(liveConfig.tally)).toBe("http://tally.example.com:9000");
  });

  it("converts ISO dates to Tally's YYYYMMDD", () => {
    expect(toTallyDate("2025-04-01")).toBe("20250401");
    expect(toTallyDate("20250401")).toBe("20250401");
    expect(toTallyDate("")).toBe("");
    expect(toTallyDate("not-a-date")).toBe("");
  });

  it("builds an Export Data request for the Day Book with period + company", () => {
    const xml = buildTallyExportRequest("Day Book", liveConfig.tally);
    expect(xml).toContain("<TALLYREQUEST>Export Data</TALLYREQUEST>");
    expect(xml).toContain("<REPORTNAME>Day Book</REPORTNAME>");
    expect(xml).toContain("<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>");
    expect(xml).toContain("<SVFROMDATE>20250401</SVFROMDATE>");
    expect(xml).toContain("<SVTODATE>20260331</SVTODATE>");
    expect(xml).toContain("<SVCURRENTCOMPANY>Acme Pvt Ltd</SVCURRENTCOMPANY>");
  });

  it("escapes XML-unsafe characters in the company name", () => {
    const cfg = { ...liveConfig.tally, company: 'A&B < "Pvt" Ltd >' };
    const xml = buildTallyExportRequest("Day Book", cfg);
    expect(xml).toContain("A&amp;B &lt; &quot;Pvt&quot; Ltd &gt;");
    expect(xml).not.toContain("A&B <");
  });

  it("omits period + company variables when unset (active company/period)", () => {
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    const xml = buildTallyExportRequest("Day Book", cfg.tally);
    expect(xml).not.toContain("SVFROMDATE");
    expect(xml).not.toContain("SVTODATE");
    expect(xml).not.toContain("SVCURRENTCOMPANY");
  });

  it("collects VOUCHER objects at any depth of a parsed envelope", () => {
    const parsed = {
      ENVELOPE: {
        BODY: {
          DATA: {
            COLLECTION: {
              VOUCHER: [
                { DATE: "20250401", VOUCHERTYPENAME: "Sales" },
                { DATE: "20250402", VOUCHERTYPENAME: "Purchase" },
              ],
            },
          },
        },
      },
    };
    const vouchers = collectTagged(parsed, "VOUCHER");
    expect(vouchers).toHaveLength(2);
    expect(vouchers[0]?.VOUCHERTYPENAME).toBe("Sales");
  });
});

describe("tally live gateway (mocked gateway)", () => {
  it("parses a real-shaped Day Book response into voucher rows", async () => {
    const requests: string[] = [];
    mockFetch(async (_url, init) => {
      requests.push(String(init?.body ?? ""));
      return XML_RESPONSE(TALLY_DAYBOOK_XML);
    });
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com", company: "Acme Pvt Ltd" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");

    const pulled = await fetchTallyGatewayRows(cfg.tally, "vouchers", 10);
    // The request must be a real Tally export envelope.
    expect(requests[0]).toContain("<TALLYREQUEST>Export Data</TALLYREQUEST>");
    expect(requests[0]).toContain("<REPORTNAME>Day Book</REPORTNAME>");
    expect(requests[0]).toContain("<SVCURRENTCOMPANY>Acme Pvt Ltd</SVCURRENTCOMPANY>");
    // Two vouchers, normalized dates, Tally sign conventions:
    // voucher value = debit side of a balanced voucher (11800), orientation
    // follows the leading ledger line's sign (party debited → "debit").
    expect(pulled.totalRows).toBe(2);
    expect(pulled.rows[0]).toEqual([
      "2025-04-01",
      "Sales",
      "INV-101",
      "Acme Retail",
      "Acme Retail",
      11800,
      "debit",
      "April invoice batch",
    ]);
    expect(pulled.rows[1]).toEqual([
      "2025-04-01",
      "Purchase",
      "BILL-77",
      "Office Supplies Co",
      "Office Supplies Co",
      2360,
      "debit",
      "",
    ]);
  });

  it("respects the row cap (honest truncation by cap, not silent)", async () => {
    mockFetch(async () => XML_RESPONSE(TALLY_DAYBOOK_XML));
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    const pulled = await fetchTallyGatewayRows(cfg.tally, "vouchers", 1);
    expect(pulled.rows).toHaveLength(1);
  });

  it("parses ledger masters with grouped opening balances", async () => {
    mockFetch(async () => XML_RESPONSE(TALLY_LEDGERS_XML));
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    const pulled = await fetchTallyGatewayRows(cfg.tally, "ledgers", 10);
    expect(pulled.totalRows).toBe(2);
    expect(pulled.rows[1]).toEqual(["Acme Retail", "Sundry Debtors", 45000, 45000, true]);
  });

  it("rejects an unknown table before any network call", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    await expect(fetchTallyGatewayRows(cfg.tally, "not-a-table", 10)).rejects.toThrow(/Unknown Tally table/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a LAN/loopback gateway host (SSRF posture, no fetch attempted)", async () => {
    mockFetch(async () => {
      throw new Error("fetch must never be called for a private host");
    });
    const lan = validateConnectorConfig("tally", { host: "192.168.1.50" });
    if (lan.kind !== "tally") throw new Error("expected tally config");
    await expect(fetchTallyGatewayVouchers(lan.tally)).rejects.toThrow(/private|internal|cannot be fetched/);
  });

  it("maps connection refusal to CONNECTOR_UNREACHABLE with the gateway remedy", async () => {
    mockFetch(async () => {
      const err = new Error("fetch failed") as Error & { code?: string };
      err.code = "ECONNREFUSED";
      throw err;
    });
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    try {
      await testTallyGatewayConnection(cfg.tally);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("CONNECTOR_UNREACHABLE");
      expect((err as ConnectorError).message).toMatch(/HTTP server is off|enable the HTTP server/i);
    }
  });

  it("refuses a non-XML answer (wrong service on the port)", async () => {
    // A plain-text answer (e.g. another service bound to :9000) is not Tally
    // XML — the gateway must refuse it loudly instead of parsing garbage.
    mockFetch(async () => new Response("hello world, not xml", { status: 200 }));
    const cfg = validateConnectorConfig("tally", { host: "tally.example.com" });
    if (cfg.kind !== "tally") throw new Error("expected tally config");
    try {
      await fetchTallyGatewayVouchers(cfg.tally);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("CONNECTOR_REMOTE");
      expect((err as ConnectorError).message).toMatch(/non-XML/);
    }
  });
});

describe("zoho books (pure pieces)", () => {
  it("exposes the four Books tables", () => {
    expect(ZOHO_BOOKS_TABLES).toEqual(["invoices", "contacts", "expenses", "journals"]);
  });

  it("has real column shapes for every table", () => {
    for (const table of ZOHO_BOOKS_TABLES) {
      const columns = zohoBooksTableColumns(table);
      expect(columns.length).toBeGreaterThan(0);
      for (const col of columns) {
        expect(["string", "number", "date"]).toContain(col.type);
      }
    }
    expect(zohoBooksTableColumns("unknown-table")).toEqual([]);
  });

  it("maps an invoice record with GST fields into the column order", () => {
    const row = mapZohoRecord("invoices", {
      invoice_number: "INV-00042",
      reference_number: "PO-991",
      date: "2025-04-12",
      due_date: "2025-05-12",
      status: "sent",
      customer_name: "Acme Retail",
      total: "11800.00",
      balance: 0,
      currency_code: "INR",
      gst_treatment: "gst_registered",
      place_of_supply: "KA",
    });
    expect(row).toEqual([
      "INV-00042",
      "PO-991",
      "2025-04-12",
      "2025-05-12",
      "sent",
      "Acme Retail",
      11800,
      0,
      "INR",
      "gst_registered",
      "KA",
    ]);
  });

  it("maps missing/blank fields to null and comma-format numeric strings to numbers", () => {
    const row = mapZohoRecord("expenses", {
      date: "2025-04-15",
      account_name: "Travel",
      total: "1,180.50",
    });
    expect(row[5]).toBe(1180.5);
    expect(row[3]).toBeNull();
    expect(row[7]).toBeNull();
  });
});

describe("zoho books (mocked API)", () => {
  const ZOHO_CONFIG = validateConnectorConfig("zoho-books", {
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    organizationId: "123456789",
  });
  if (ZOHO_CONFIG.kind !== "zoho-books") throw new Error("expected zoho-books config");

  const TOKEN_OK = () =>
    new Response(JSON.stringify({ access_token: "at-1000" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const PAGE_OK = (records: Record<string, unknown>[], hasMore = false) =>
    new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        page_context: { has_more_page: hasMore, total: records.length },
        invoices: records,
        contacts: records,
        expenses: records,
        journals: records,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("pulls invoices end-to-end: refresh token → access token → paginated GET", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth/v2/token")) return TOKEN_OK();
      return PAGE_OK([
        {
          invoice_number: "INV-00042",
          date: "2025-04-12",
          status: "sent",
          customer_name: "Acme Retail",
          total: "11800.00",
          balance: 0,
          currency_code: "INR",
          gst_treatment: "gst_registered",
          place_of_supply: "KA",
        },
      ]);
    });

    const pulled = await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 50);
    // Token minted against the India DC, API called with org id + auth header.
    expect(calls.some((c) => c.url.startsWith("https://accounts.zoho.in/oauth/v2/token"))).toBe(true);
    const apiCall = calls.find((c) => c.url.includes("/books/v3/invoices"));
    expect(apiCall).toBeDefined();
    expect(apiCall?.url).toContain("organization_id=123456789");
    expect((apiCall?.init?.headers as Record<string, string>).Authorization).toBe("Zoho-oauthtoken at-1000");
    expect(pulled.totalRows).toBe(1);
    expect(pulled.rows[0]?.[0]).toBe("INV-00042");
    expect(pulled.truncated).toBe(false);
  });

  it("follows pagination until has_more_page is false", async () => {
    let page = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/oauth/v2/token")) return TOKEN_OK();
      page += 1;
      return PAGE_OK([{ invoice_number: `INV-${page}` }], page < 2);
    });
    const pulled = await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 50);
    expect(page).toBe(2);
    expect(pulled.totalRows).toBe(2);
    expect(pulled.rows.map((r) => r[0])).toEqual(["INV-1", "INV-2"]);
  });

  it("stops at the row cap mid-pagination (truncated honestly)", async () => {
    let page = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/oauth/v2/token")) return TOKEN_OK();
      page += 1;
      return PAGE_OK([{ invoice_number: `INV-${page}` }], true);
    });
    const pulled = await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 3);
    expect(pulled.rows).toHaveLength(3);
    expect(pulled.truncated).toBe(true);
  });

  it("maps an OAuth rejection to CONNECTOR_AUTH with the region remedy", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      await testZohoBooksConnection(ZOHO_CONFIG.zohoBooks);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("CONNECTOR_AUTH");
      expect((err as ConnectorError).message).toMatch(/invalid_code/);
      expect((err as ConnectorError).message).toMatch(/India/);
    }
  });

  it("maps an upstream 5xx to CONNECTOR_REMOTE — never a false auth error", async () => {
    mockFetch(async () => new Response("<html>gateway error</html>", { status: 500 }));
    try {
      await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 10);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("CONNECTOR_REMOTE");
      expect((err as ConnectorError).message).not.toMatch(/refresh token|credentials/i);
    }
  });

  it("maps an unreachable token host to CONNECTOR_UNREACHABLE", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 10);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe("CONNECTOR_UNREACHABLE");
    }
  });

  it("maps a Zoho API-level error (code != 0) to a clean message", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("/oauth/v2/token")) return TOKEN_OK();
      return new Response(JSON.stringify({ code: 13, message: "Organization id is invalid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "invoices", 10);
      throw new Error("expected the call to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).message).toMatch(/Organization id is invalid/);
    }
  });

  it("rejects an unknown table before any network call", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    await expect(fetchZohoBooksRows(ZOHO_CONFIG.zohoBooks, "not-a-table", 10)).rejects.toThrow(
      /Unknown Zoho Books table/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defines exactly the eight supported data centers, each with its own hosts", () => {
    expect(ZOHO_BOOKS_REGIONS).toHaveLength(8);
    expect(new Set(ZOHO_BOOKS_REGIONS.map((region) => region.value)).size).toBe(8);
    for (const region of ZOHO_BOOKS_REGIONS) {
      expect(region.accountsHost).toMatch(/^accounts\.[a-z0-9.-]+$/);
      expect(region.apiHost).toMatch(/^www\.[a-z0-9.-]+$/);
      expect(region.hint.length).toBeGreaterThan(20);
      expect(ZOHO_BOOKS_REGION_META[region.value]).toBe(region);
    }
    expect(ZOHO_BOOKS_REGION_META.in.accountsHost).toBe("accounts.zoho.in");
    expect(ZOHO_BOOKS_REGION_META.us.accountsHost).toBe("accounts.zoho.com");
    expect(ZOHO_BOOKS_REGION_META.eu.apiHost).toBe("www.zohoapis.eu");
    expect(ZOHO_BOOKS_REGION_META.ca.accountsHost).toBe("accounts.zohocloud.ca");
    expect(ZOHO_BOOKS_REGION_META.cn.apiHost).toBe("www.zohoapis.com.cn");
  });

  it("mints tokens and calls the Books API on each of the eight data centers", async () => {
    for (const region of ZOHO_BOOKS_REGIONS) {
      const calls: string[] = [];
      mockFetch(async (url) => {
        calls.push(String(url));
        if (String(url).includes("/oauth/v2/token")) return TOKEN_OK();
        return new Response(
          JSON.stringify({
            code: 0,
            message: "success",
            organizations: [{ organization_id: "123456789", name: `Org ${region.name}` }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const result = await testZohoBooksConnection({ ...ZOHO_CONFIG.zohoBooks, region: region.value });
      expect(result.serverVersion).toBe(`Zoho Books (${region.name})`);
      expect(result.database).toBe(`Org ${region.name}`);
      expect(calls.some((url) => url.startsWith(`https://${region.accountsHost}/oauth/v2/token`))).toBe(true);
      expect(calls.some((url) => url.startsWith(`https://${region.apiHost}/books/v3/organizations`))).toBe(true);
    }
  });

  it("refuses an unknown data center with the supported list instead of falling back to India", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const bad = { ...ZOHO_CONFIG.zohoBooks, region: "nz" as never };
    await expect(testZohoBooksConnection(bad)).rejects.toThrow(/Unknown Zoho Books data center “nz”/);
    await expect(testZohoBooksConnection(bad)).rejects.toThrow(/“in” \(India\)/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unsupported region at config validation", () => {
    expect(() =>
      validateConnectorConfig("zoho-books", {
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        region: "nz",
      }),
    ).toThrow(/Invalid Zoho Books settings/);
  });
});
