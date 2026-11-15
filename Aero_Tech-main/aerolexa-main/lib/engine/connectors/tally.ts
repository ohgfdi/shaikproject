/**
 * Tally connector — parses Tally exports (TCML/XML and CSV) into typed rows.
 *
 * Tally exports come in two main flavours:
 * - TCML (Tally XML): structured XML with ledger/voucher data, used by Tally Prime/ERP9
 * - CSV: simpler comma-separated export of ledgers/vouchers
 *
 * Both are file-based parsers (not database connections). The connector receives
 * the uploaded file path and returns typed rows matching the standard shape.
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as _path from "node:path";
import { parseStringPromise } from "xml2js";

import { assertSafeExternalUrl } from "@/lib/server/url-guard";
import type { ColType, SqlValue } from "@/lib/types";

import type { TallyConfig } from "./config";
import { ConnectorError } from "./errors";

export interface TallyVoucher {
  date: string;
  voucherType: string;
  voucherNumber: string;
  partyName: string;
  ledgerName: string;
  amount: number;
  debitCredit: "debit" | "credit";
  narration?: string;
}

export interface TallyLedger {
  name: string;
  group: string;
  openingBalance: number;
  closingBalance: number;
  isDebit: boolean;
}

/**
 * Parse a Tally TCML (XML) export file.
 * Returns vouchers and ledgers extracted from the XML.
 */
export async function parseTallyTcml(
  filePath: string,
  _config: TallyConfig,
): Promise<{
  vouchers: TallyVoucher[];
  ledgers: TallyLedger[];
}> {
  const xml = await fs.readFile(filePath, "utf-8");
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: false,
    trim: true,
  });

  const vouchers: TallyVoucher[] = [];
  const ledgers: TallyLedger[] = [];

  // Tally TCML structure varies by version. Handle common patterns.
  const envelope = parsed.ENVELOPE ?? parsed.Envelope;
  if (!envelope) {
    throw new ConnectorError("Invalid TCML: missing ENVELOPE root element.", {
      status: 400,
      code: "TALLY_PARSE_ERROR",
    });
  }

  const body = envelope.BODY ?? envelope.Body;
  if (!body) {
    throw new ConnectorError("Invalid TCML: missing BODY element.", {
      status: 400,
      code: "TALLY_PARSE_ERROR",
    });
  }

  // Extract vouchers from DATA/DATA/COLLECTION/VOUCHER
  const data = body.DATA ?? body.Data;
  if (data?.COLLECTION) {
    const collections = Array.isArray(data.COLLECTION) ? data.COLLECTION : [data.COLLECTION];
    for (const collection of collections) {
      if (collection.VOUCHER) {
        const vouchersList = Array.isArray(collection.VOUCHER) ? collection.VOUCHER : [collection.VOUCHER];
        for (const voucher of vouchersList) {
          const parsedVoucher = parseTcmlVoucher(voucher);
          if (parsedVoucher) vouchers.push(parsedVoucher);
        }
      }
      if (collection.LEDGER) {
        const ledgersList = Array.isArray(collection.LEDGER) ? collection.LEDGER : [collection.LEDGER];
        for (const ledger of ledgersList) {
          const parsedLedger = parseTcmlLedger(ledger);
          if (parsedLedger) ledgers.push(parsedLedger);
        }
      }
    }
  }

  return { vouchers, ledgers };
}

function parseTcmlVoucher(v: Record<string, unknown>): TallyVoucher | null {
  try {
    const date = String(v.DATE ?? v.Date ?? "");
    const voucherType = String(v.VOUCHERTYPENAME ?? v.VoucherTypeName ?? "");
    const voucherNumber = String(v.VOUCHERNUMBER ?? v.VoucherNumber ?? "");
    const partyName = String(v.PARTYNAME ?? v.PartyName ?? "");
    const amountStr = String(v.AMOUNT ?? v.Amount ?? "0");
    const amount = parseFloat(amountStr.replace(/,/g, "")) || 0;
    const debitCredit = String(v.DC ?? v.Dc ?? "").toLowerCase() === "debit" || amount < 0 ? "debit" : "credit";
    const narration = String(v.NARRATION ?? v.Narration ?? "");
    const ledgerName = String(v.LEDGERNAME ?? v.LedgerName ?? "");

    if (!date || !voucherType) return null;

    return {
      date: normalizeDate(date),
      voucherType,
      voucherNumber,
      partyName,
      ledgerName,
      amount: Math.abs(amount),
      debitCredit,
      narration,
    };
  } catch {
    return null;
  }
}

function parseTcmlLedger(l: Record<string, unknown>): TallyLedger | null {
  try {
    const name = String(l.NAME ?? l.Name ?? "");
    const group = String(l.PARENT ?? l.Parent ?? "");
    const openingBalance = parseFloat(String(l.OPENINGBALANCE ?? l.OpeningBalance ?? "0").replace(/,/g, "")) || 0;
    const closingBalance = parseFloat(String(l.CLOSINGBALANCE ?? l.ClosingBalance ?? "0").replace(/,/g, "")) || 0;
    const isDebit = closingBalance >= 0;

    if (!name) return null;

    return { name, group, openingBalance, closingBalance, isDebit };
  } catch {
    return null;
  }
}

/**
 * Parse a Tally CSV export file.
 * Expected columns: Date, Voucher Type, Voucher No, Party Name, Ledger Name, Amount, Dr/Cr, Narration
 */
export function parseTallyCsv(filePath: string, _config: TallyConfig): TallyVoucher[] {
  const content = readFileSync(filePath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const vouchers: TallyVoucher[] = [];

  for (const row of records) {
    const date = row.Date ?? row.date ?? row["Date "] ?? "";
    const voucherType = row["Voucher Type"] ?? row["VoucherType"] ?? row["Voucher Type "] ?? "";
    const voucherNumber = row["Voucher No"] ?? row["VoucherNo"] ?? row["Voucher Number"] ?? "";
    const partyName = row["Party Name"] ?? row["PartyName"] ?? row["Party Name "] ?? "";
    const ledgerName = row["Ledger Name"] ?? row["LedgerName"] ?? row["Ledger Name "] ?? "";
    const amountStr = row.Amount ?? row.amount ?? row["Amount "] ?? "0";
    const dc = row["Dr/Cr"] ?? row["Dr/Cr "] ?? row.DC ?? "";
    const narration = row.Narration ?? row.narration ?? "";

    if (!date || !voucherType) continue;

    const amount = parseFloat(amountStr.replace(/,/g, "")) || 0;
    const debitCredit = dc.toLowerCase() === "dr" || dc.toLowerCase() === "debit" || amount < 0 ? "debit" : "credit";

    vouchers.push({
      date: normalizeDate(date),
      voucherType,
      voucherNumber,
      partyName,
      ledgerName,
      amount: Math.abs(amount),
      debitCredit,
      narration,
    });
  }

  return vouchers;
}

/**
 * Convert vouchers + ledgers to the standard column/row format for dataset creation.
 */
export function tallyToRows(
  vouchers: TallyVoucher[],
  ledgers: TallyLedger[],
): {
  vouchers: { columns: { name: string; type: ColType }[]; rows: SqlValue[][] };
  ledgers: { columns: { name: string; type: ColType }[]; rows: SqlValue[][] };
} {
  const voucherColumns: { name: string; type: ColType }[] = [
    { name: "date", type: "date" },
    { name: "voucher_type", type: "string" },
    { name: "voucher_number", type: "string" },
    { name: "party_name", type: "string" },
    { name: "ledger_name", type: "string" },
    { name: "amount", type: "number" },
    { name: "debit_credit", type: "string" },
    { name: "narration", type: "string" },
  ];

  const ledgerColumns: { name: string; type: ColType }[] = [
    { name: "name", type: "string" },
    { name: "group", type: "string" },
    { name: "opening_balance", type: "number" },
    { name: "closing_balance", type: "number" },
    { name: "is_debit", type: "boolean" },
  ];

  const voucherRows: SqlValue[][] = vouchers.map((v) => [
    v.date,
    v.voucherType,
    v.voucherNumber,
    v.partyName,
    v.ledgerName,
    v.amount,
    v.debitCredit,
    v.narration ?? null,
  ]);

  const ledgerRows: SqlValue[][] = ledgers.map((l) => [l.name, l.group, l.openingBalance, l.closingBalance, l.isDebit]);

  return {
    vouchers: { columns: voucherColumns, rows: voucherRows },
    ledgers: { columns: ledgerColumns, rows: ledgerRows },
  };
}

function normalizeDate(dateStr: string): string {
  // Handle common Tally date formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YYYY
  const cleaned = dateStr.trim().replace(/\//g, "-");
  // Tally XML (TCML + gateway responses) uses compact YYYYMMDD.
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }
  const parts = cleaned.split("-");
  if (parts.length === 3) {
    const d = parts[0] ?? "";
    const m = parts[1] ?? "";
    const y = parts[2] ?? "";
    if (y.length === 4) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (d.length === 4) return `${d}-${m.padStart(2, "0")}-${y.padStart(2, "0")}`;
    // Assume DD-MM-YY
    return `20${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Try parsing as ISO
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0] ?? dateStr;
  return dateStr;
}

/* ------------------------------------------------------------------ */
/* Live Tally XML gateway (TallyPrime HTTP server)                     */
/* ------------------------------------------------------------------ */
/*
 * TallyPrime ships an XML-over-HTTP gateway (F1 Help → Settings →
 * Advanced Configuration → enable the HTTP server; default port 9000).
 * Third-party apps POST an ENVELOPE request and receive an ENVELOPE
 * response — no JSON, no OAuth. When `host` is set in the config this
 * connector talks to that gateway instead of parsing an uploaded export
 * file; with `host` empty it stays in the original file-parser mode.
 *
 * SSRF posture: the gateway is by definition an on-prem LAN/localhost
 * service, so a multi-tenant deployment must NOT fetch it by default.
 * Without the escape hatch, the host must be a publicly reachable
 * hostname (e.g. a tunnel); with `CONNECTOR_ALLOW_PRIVATE_URLS=true` a
 * self-hosted deployment may point at its own LAN Tally.
 */

const TALLY_QUERY_TIMEOUT_MS = 30_000;

/** `YYYY-MM-DD` / `YYYYMMDD` → Tally's required `YYYYMMDD`. Empty stays empty. */
export function toTallyDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.replace(/-/g, "");
  if (/^\d{8}$/.test(trimmed)) return trimmed;
  return "";
}

/** The gateway URL for a config (always plain http — Tally speaks no TLS). */
export function tallyGatewayUrl(config: TallyConfig): string {
  const host = (config.host ?? "").trim();
  return `http://${host}:${config.port}`;
}

/**
 * SSRF gate for the Tally gateway. Default: the host must be a public,
 * resolvable name (a tunnel in front of Tally). Self-hosted deployments
 * opt out with CONNECTOR_ALLOW_PRIVATE_URLS=true to reach their own LAN.
 */
export async function assertTallyGatewayAllowed(config: TallyConfig): Promise<string> {
  const url = tallyGatewayUrl(config);
  if (process.env.CONNECTOR_ALLOW_PRIVATE_URLS === "true") return url;
  // Reuses the shared guard so the SaaS posture stays consistent with the
  // REST connector: loopback/link-local/private ranges fail closed. The
  // guard's UrlGuardError is translated to ConnectorError so the connector
  // surface uniformly throws one error type (status + code preserved).
  try {
    await assertSafeExternalUrl(url);
  } catch (err) {
    if (err instanceof Error && err.name === "UrlGuardError") {
      const guard = err as Error & { status?: number; code?: string };
      throw new ConnectorError(guard.message, {
        status: guard.status ?? 400,
        code: guard.code ?? "CONNECTOR_CONFIG",
      });
    }
    throw err;
  }
  return url;
}

/** Build an `Export Data` request for a report (Day Book → vouchers, List of Accounts → masters). */
export function buildTallyExportRequest(report: "Day Book" | "List of Accounts", config: TallyConfig): string {
  const from = toTallyDate(config.fromDate ?? "");
  const to = toTallyDate(config.toDate ?? "");
  const company = (config.company ?? "").trim();
  const variables = [
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    from ? `<SVFROMDATE>${from}</SVFROMDATE>` : "",
    to ? `<SVTODATE>${to}</SVTODATE>` : "",
    company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : "",
  ]
    .filter(Boolean)
    .join("");
  return [
    "<ENVELOPE>",
    " <HEADER>",
    "  <TALLYREQUEST>Export Data</TALLYREQUEST>",
    " </HEADER>",
    " <BODY>",
    "  <EXPORTDATA>",
    "   <REQUESTDESC>",
    `    <REPORTNAME>${report}</REPORTNAME>`,
    "    <STATICVARIABLES>",
    variables,
    "    </STATICVARIABLES>",
    "   </REQUESTDESC>",
    "  </EXPORTDATA>",
    " </BODY>",
    "</ENVELOPE>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

/** POST an export request to the gateway and return the raw XML response. */
export async function fetchTallyGatewayResponse(config: TallyConfig, requestXml: string): Promise<string> {
  const url = await assertTallyGatewayAllowed(config);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/xml;charset=utf-8" },
      body: requestXml,
      signal: AbortSignal.timeout(TALLY_QUERY_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ConnectorError(
        `The Tally gateway at ${url} did not answer in time. What happened: Tally may be busy or the gateway is not enabled. How to fix: confirm the TallyPrime HTTP server is on (F1 Help → Settings → Advanced Configuration) and retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    }
    throw new ConnectorError(
      `Could not reach the Tally gateway at ${url}. What happened: the connection was refused — Tally may not be running, or the HTTP server is off (default port 9000). How to fix: start TallyPrime, enable the HTTP server, and confirm host and port.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ConnectorError(
      `The Tally gateway answered HTTP ${res.status}. What happened: the request was not accepted. How to fix: confirm the gateway is enabled and this account is allowed to export data.`,
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  if (!text.trim().startsWith("<")) {
    throw new ConnectorError(
      "The Tally gateway returned a non-XML response. What happened: the endpoint answered, but not with Tally XML. How to fix: verify the port points at the TallyPrime HTTP server, not another service.",
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  }
  return text;
}

/** Walk a parsed-XML tree and collect every object tagged `tag` (any depth). */
export function collectTagged(node: unknown, tag: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const tagged = record[tag];
      if (tagged !== undefined) {
        const list = Array.isArray(tagged) ? tagged : [tagged];
        for (const item of list) {
          if (item !== null && typeof item === "object") found.push(item as Record<string, unknown>);
        }
      }
      for (const value of Object.values(record)) visit(value);
    }
  };
  visit(node);
  return found;
}

/**
 * Export vouchers (Day Book) through the live gateway and parse them into
 * the same TallyVoucher shape the file parser produces, so downstream
 * materialization is identical regardless of mode.
 */
export async function fetchTallyGatewayVouchers(config: TallyConfig): Promise<TallyVoucher[]> {
  const xml = await fetchTallyGatewayResponse(config, buildTallyExportRequest("Day Book", config));
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true }).catch(() => {
    throw new ConnectorError(
      "The Tally gateway response could not be parsed as XML. How to fix: retry; if it persists, check the TallyPrime version.",
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  });
  const vouchers: TallyVoucher[] = [];
  for (const v of collectTagged(parsed, "VOUCHER")) {
    const voucher = liveVoucherToTallyVoucher(v);
    if (voucher) vouchers.push(voucher);
  }
  return vouchers;
}

function liveVoucherToTallyVoucher(v: Record<string, unknown>): TallyVoucher | null {
  const date = String(v.DATE ?? "");
  const voucherType = String(v.VOUCHERTYPENAME ?? "");
  if (!date || !voucherType) return null;
  const entries = Array.isArray(v["ALLLEDGERENTRIES.LIST"])
    ? (v["ALLLEDGERENTRIES.LIST"] as Record<string, unknown>[])
    : v["ALLLEDGERENTRIES.LIST"] && typeof v["ALLLEDGERENTRIES.LIST"] === "object"
      ? [v["ALLLEDGERENTRIES.LIST"] as Record<string, unknown>]
      : [];
  const firstEntry = entries[0];
  // Tally signs ledger entries: positive = debit, negative = credit. A
  // balanced voucher nets to zero across both sides, so the voucher's
  // commercial value is the debit side (falling back to the credit side for
  // one-sided fragments). A top-level AMOUNT (some exports carry it) wins.
  const entryAmounts = entries.map((e) => {
    const a = parseFloat(String(e.AMOUNT ?? "0").replace(/,/g, ""));
    return Number.isFinite(a) ? a : 0;
  });
  const debitSide = entryAmounts.filter((a) => a > 0).reduce((s, a) => s + a, 0);
  const creditSide = Math.abs(entryAmounts.filter((a) => a < 0).reduce((s, a) => s + a, 0));
  const topAmount = parseFloat(String(v.AMOUNT ?? "0").replace(/,/g, ""));
  const amount =
    Number.isFinite(topAmount) && topAmount !== 0 ? Math.abs(topAmount) : debitSide > 0 ? debitSide : creditSide;
  // Orientation follows the leading ledger line's sign (true Tally
  // convention: positive = debit), not a heuristic on the voucher total.
  const firstSign = entryAmounts[0] ?? (Number.isFinite(topAmount) ? topAmount : 0);
  const ledgerName = String((firstEntry?.LEDGERNAME as string | undefined) ?? v.PARTYLEDGERNAME ?? v.PARTYNAME ?? "");
  return {
    date: normalizeDate(date),
    voucherType,
    voucherNumber: String(v.VOUCHERNUMBER ?? ""),
    partyName: String(v.PARTYNAME ?? v.PARTYLEDGERNAME ?? ""),
    ledgerName,
    amount,
    debitCredit: firstSign < 0 ? "credit" : "debit",
    narration: String(v.NARRATION ?? ""),
  };
}

/**
 * Export ledger masters (List of Accounts) through the live gateway.
 * Closing balances are not part of a master export, so they mirror the
 * opening balance — the honest shape of what Tally returns here.
 */
export async function fetchTallyGatewayLedgers(config: TallyConfig): Promise<TallyLedger[]> {
  const xml = await fetchTallyGatewayResponse(config, buildTallyExportRequest("List of Accounts", config));
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true }).catch(() => {
    throw new ConnectorError(
      "The Tally gateway response could not be parsed as XML. How to fix: retry; if it persists, check the TallyPrime version.",
      { status: 502, code: "CONNECTOR_REMOTE" },
    );
  });
  const ledgers: TallyLedger[] = [];
  for (const l of collectTagged(parsed, "LEDGER")) {
    const name = String(l.NAME ?? "");
    if (!name) continue;
    const opening = parseFloat(String(l.OPENINGBALANCE ?? "0").replace(/,/g, "")) || 0;
    ledgers.push({
      name,
      group: String(l.PARENT ?? ""),
      openingBalance: opening,
      closingBalance: opening,
      isDebit: opening >= 0,
    });
  }
  return ledgers;
}

/** Live connection test: a minimal List of Accounts export must answer with Tally XML. */
export async function testTallyGatewayConnection(
  config: TallyConfig,
): Promise<{ serverVersion: string; latencyMs: number; database: string }> {
  const started = Date.now();
  const xml = await fetchTallyGatewayResponse(config, buildTallyExportRequest("List of Accounts", config));
  const parsed = (await parseStringPromise(xml, { explicitArray: false, trim: true }).catch(() => null)) as unknown;
  const ledgerCount = parsed ? collectTagged(parsed, "LEDGER").length : 0;
  const company = (config.company ?? "").trim();
  return {
    serverVersion: `Tally XML Gateway (${ledgerCount} ledger masters)`,
    latencyMs: Date.now() - started,
    database: company || "active company",
  };
}

/** Live gateway rows in the dispatcher's PulledTable shape. */
export async function fetchTallyGatewayRows(
  config: TallyConfig,
  table: string,
  limit: number,
): Promise<{ columns: { name: string; type: ColType }[]; rows: SqlValue[][]; totalRows: number; truncated: boolean }> {
  const cap = Math.max(1, Math.floor(limit));
  if (table === "vouchers") {
    const vouchers = (await fetchTallyGatewayVouchers(config)).slice(0, cap);
    const { vouchers: data } = tallyToRows(vouchers, []);
    return { columns: data.columns, rows: data.rows, totalRows: vouchers.length, truncated: false };
  }
  if (table === "ledgers") {
    const ledgers = (await fetchTallyGatewayLedgers(config)).slice(0, cap);
    const { ledgers: data } = tallyToRows([], ledgers);
    return { columns: data.columns, rows: data.rows, totalRows: ledgers.length, truncated: false };
  }
  throw new ConnectorError(`Unknown Tally table: ${table}. Use "vouchers" or "ledgers".`, {
    status: 404,
    code: "CONNECTOR_NOT_FOUND",
  });
}
