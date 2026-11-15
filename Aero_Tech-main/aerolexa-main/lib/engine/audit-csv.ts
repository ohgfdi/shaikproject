/**
 * Audit-trail CSV export (pure, RFC-4180).
 *
 * An auditor must be able to answer "who changed dataset X last month?" from
 * one export. The serializer is deliberately paranoid:
 *
 *  - RFC-4180 quoting: fields containing comma, quote, CR or LF are wrapped
 *    in double quotes; embedded quotes are doubled.
 *  - CSV-injection guard: a leading =, +, −/−, @ or TAB in a text field is
 *    prefixed with a single quote so spreadsheet apps treat it as text — an
 *    exported audit log must never become an execution vector.
 *  - Deterministic: same entries ⇒ byte-identical file.
 */

export interface AuditCsvEntry {
  createdAt: string;
  type: string;
  message: string;
  actorName: string | null;
  actorEmail: string | null;
  projectName: string | null;
  security: boolean;
}

export const AUDIT_CSV_COLUMNS = [
  "When (UTC)",
  "Type",
  "Actor",
  "Actor email",
  "Project",
  "Event",
  "Security-relevant",
] as const;

/** Guard a text field against CSV formula injection. */
export function guardCsvField(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** Quote per RFC-4180. */
function quote(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function auditEntriesToCsv(entries: AuditCsvEntry[]): string {
  const lines = [AUDIT_CSV_COLUMNS.map((c) => quote(c)).join(",")];
  for (const e of entries) {
    const cells = [
      e.createdAt,
      e.type,
      e.actorName ?? "—",
      e.actorEmail ?? "—",
      e.projectName ?? "—",
      e.message,
      e.security ? "yes" : "no",
    ].map((c) => quote(guardCsvField(String(c))));
    lines.push(cells.join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
