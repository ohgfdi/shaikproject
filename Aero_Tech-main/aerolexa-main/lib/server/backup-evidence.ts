/**
 * Backup-drill evidence.
 *
 * `scripts/backup-drill.mjs` proves a dump can be restored, but the proof used
 * to live only in a console line and a markdown row: a later operator could not
 * tell from the running app whether the last drill passed or when it ran. This
 * module reads the drill's machine-readable receipt and turns it into a
 * posture `/api/health` can report.
 *
 * Honesty rules:
 *  - a missing or unreadable receipt is "no evidence", never "fine";
 *  - a failed receipt is critical regardless of age;
 *  - a stale pass is a warning with the drill command as the remedy;
 *  - nothing here invents a backup. The only writer is the drill itself.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const BACKUP_RECEIPT_FILE = "backup-drill.json";
export const BACKUP_MAX_AGE_DAYS = 30;

export interface BackupReceipt {
  /** ISO timestamp of the drill. */
  ranAt: string;
  ok: boolean;
  /** Rows compared between source and restored database. */
  rows: number | null;
  /** Free-form note describing what was verified. */
  note: string | null;
}

export type BackupSeverity = "ok" | "warn" | "critical";

export interface BackupPosture {
  severity: BackupSeverity;
  verified: boolean;
  /** Age of the receipt in whole days, or null when there is no usable one. */
  ageDays: number | null;
  ranAt: string | null;
  summary: string;
  remedy: string;
}

/** The file is small and written by us; validate its shape explicitly anyway. */
export function parseBackupReceipt(raw: unknown): BackupReceipt | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.ranAt !== "string" || !Number.isFinite(Date.parse(value.ranAt))) return null;
  if (typeof value.ok !== "boolean") return null;
  return {
    ranAt: value.ranAt,
    ok: value.ok,
    rows: typeof value.rows === "number" && Number.isFinite(value.rows) ? value.rows : null,
    note: typeof value.note === "string" && value.note.trim() !== "" ? value.note : null,
  };
}

const DAY_MS = 86_400_000;

/** Pure posture matrix — injected clock so the rule is testable. */
export function backupPosture(
  receipt: BackupReceipt | null,
  now: Date,
  maxAgeDays: number = BACKUP_MAX_AGE_DAYS,
): BackupPosture {
  if (!receipt) {
    return {
      severity: "warn",
      verified: false,
      ageDays: null,
      ranAt: null,
      summary: "No backup drill receipt is on record, so no restore has been proven on this host.",
      remedy: "Run `npm run drill:backup` and keep data/backup-drill.json; it writes the receipt on success.",
    };
  }

  const ranAtMs = Date.parse(receipt.ranAt);
  const ageDays = Math.max(0, Math.floor((now.getTime() - ranAtMs) / DAY_MS));

  if (!receipt.ok) {
    return {
      severity: "critical",
      verified: false,
      ageDays,
      ranAt: receipt.ranAt,
      summary: `The last backup drill failed (${receipt.ranAt}). A restore has not been proven.`,
      remedy: "Read the drill output, fix the failure, and re-run `npm run drill:backup`.",
    };
  }

  if (ageDays > maxAgeDays) {
    return {
      severity: "warn",
      verified: true,
      ageDays,
      ranAt: receipt.ranAt,
      summary: `The last successful backup drill is ${ageDays} days old (limit ${maxAgeDays}).`,
      remedy: "Re-run `npm run drill:backup` this month so the restore is proven against the current schema.",
    };
  }

  return {
    severity: "ok",
    verified: true,
    ageDays,
    ranAt: receipt.ranAt,
    summary: `A restore was verified ${ageDays} day${ageDays === 1 ? "" : "s"} ago${
      receipt.rows !== null ? ` (${receipt.rows.toLocaleString("en-IN")} rows compared)` : ""
    }.`,
    remedy: "No action. Re-run the drill after schema or storage changes.",
  };
}

/** Read the receipt the drill writes. Never throws: a bad file is no evidence. */
export async function readBackupReceipt(
  file: string = process.env.BACKUP_RECEIPT_FILE ?? path.join(process.cwd(), "data", BACKUP_RECEIPT_FILE),
): Promise<BackupReceipt | null> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parseBackupReceipt(raw);
  } catch {
    return null;
  }
}
