/**
 * Bulk client onboarding (CSV).
 *
 * The first real friction in a pilot is not filing; it is typing 80 clients into
 * a form. This parser turns a firm's client list into validated rows and
 * reports every bad line by number, instead of importing half a book and
 * silently defaulting the rest.
 *
 * It is deliberately conservative: an unknown entity kind or a malformed GSTIN
 * is an error, not a default. A wrong constitution changes the compliance
 * calendar, so guessing here would manufacture wrong due dates.
 */

import { ENTITY_KINDS, parseFinancialYear, type EntityKind, type GstFrequency } from "./compliance-calendar";

export interface ClientImportRow {
  line: number;
  name: string;
  code: string | null;
  gstin: string | null;
  entityKind: EntityKind;
  state: string | null;
  financialYear: string;
  gstRegistered: boolean;
  gstFrequency: GstFrequency;
  tdsDeductor: boolean;
  taxAuditApplicable: boolean;
  employsStaff: boolean;
}

export interface ClientImportError {
  line: number;
  message: string;
}

export interface ClientImportParse {
  rows: ClientImportRow[];
  errors: ClientImportError[];
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function keyOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ALIASES: Record<string, string> = {
  name: "name",
  client: "name",
  clientname: "name",
  legalname: "name",
  code: "code",
  clientcode: "code",
  shortcode: "code",
  gstin: "gstin",
  gstno: "gstin",
  gstnumber: "gstin",
  entitykind: "entityKind",
  entity: "entityKind",
  entitytype: "entityKind",
  constitution: "entityKind",
  state: "state",
  financialyear: "financialYear",
  fy: "financialYear",
  gstregistered: "gstRegistered",
  gst: "gstRegistered",
  gstfrequency: "gstFrequency",
  tdsdeductor: "tdsDeductor",
  tds: "tdsDeductor",
  taxauditapplicable: "taxAuditApplicable",
  audit: "taxAuditApplicable",
  employsstaff: "employsStaff",
  staff: "employsStaff",
};

function truthy(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function normalizeEntity(value: string): EntityKind | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized) return "company";
  const found = ENTITY_KINDS.find((kind) => kind.replace(/[^a-z]/g, "") === normalized);
  return found ?? null;
}

export function parseClientImportCsv(
  csv: string,
  options: { defaultFinancialYear: string },
): ClientImportParse {
  const matrix = parseCsv(csv);
  const rows: ClientImportRow[] = [];
  const errors: ClientImportError[] = [];
  if (matrix.length === 0) {
    return { rows, errors: [{ line: 0, message: "The file is empty." }] };
  }

  const header = matrix[0]!.map((cell) => ALIASES[keyOf(cell)] ?? null);
  if (!header.includes("name")) {
    return {
      rows,
      errors: [{ line: 1, message: "The header must include a name/client column." }],
    };
  }

  const seenCodes = new Map<string, number>();
  matrix.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const raw: Record<string, string> = {};
    header.forEach((key, column) => {
      if (key) raw[key] = (cells[column] ?? "").trim();
    });

    const name = raw.name ?? "";
    if (!name) {
      errors.push({ line, message: "Client name is required." });
      return;
    }

    const gstin = (raw.gstin ?? "").toUpperCase();
    if (gstin && !GSTIN_RE.test(gstin)) {
      errors.push({ line, message: `GSTIN "${gstin}" is malformed (15 characters, state code + PAN + check).` });
      return;
    }

    const entityKind = normalizeEntity(raw.entityKind ?? "");
    if (!entityKind) {
      errors.push({
        line,
        message: `Unknown entity kind "${raw.entityKind}". Use ${ENTITY_KINDS.join(", ")}.`,
      });
      return;
    }

    const financialYear = raw.financialYear || options.defaultFinancialYear;
    try {
      parseFinancialYear(financialYear);
    } catch {
      errors.push({ line, message: `Financial year "${financialYear}" must look like 2025-26.` });
      return;
    }

    const code = raw.code ? raw.code.toUpperCase() : null;
    if (code) {
      const previous = seenCodes.get(code);
      if (previous) {
        errors.push({ line, message: `Client code "${code}" is already used on line ${previous}.` });
        return;
      }
      seenCodes.set(code, line);
    }

    const gstFrequency: GstFrequency = raw.gstFrequency?.toLowerCase() === "quarterly" ? "quarterly" : "monthly";

    rows.push({
      line,
      name,
      code,
      gstin: gstin || null,
      entityKind,
      state: raw.state ? raw.state.toLowerCase() : null,
      financialYear,
      gstRegistered: truthy(raw.gstRegistered, Boolean(gstin)),
      gstFrequency,
      tdsDeductor: truthy(raw.tdsDeductor, true),
      taxAuditApplicable: truthy(raw.taxAuditApplicable, entityKind === "company"),
      employsStaff: truthy(raw.employsStaff, false),
    });
  });

  return { rows, errors };
}
