/**
 * Tamper-evident audit trail.
 *
 * Each entry commits to the previous entry's hash, so changing any historical
 * row invalidates every hash after it. The chain is per book; verification is
 * a linear scan and is exposed for operators/tests rather than on the request
 * path.
 *
 * The canonical payload is deliberately explicit (field order fixed) rather
 * than `JSON.stringify(row)`: adding a column must not silently change every
 * historical hash.
 */

import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export interface AuditInput {
  bookId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  actorName?: string | null;
  fieldChanges?: string | null;
  before?: string | null;
  after?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Tx = Pick<Prisma.TransactionClient, "bookAuditEntry">;

function canonical(input: AuditInput, createdAt: Date): string {
  return [
    input.bookId,
    input.entityType,
    input.entityId,
    input.action,
    input.actorId,
    input.fieldChanges ?? "",
    input.before ?? "",
    input.after ?? "",
    createdAt.toISOString(),
  ].join("\u001f");
}

export function hashAuditPayload(prevHash: string | null, payload: string): string {
  return createHash("sha256")
    .update(`${prevHash ?? ""}\u001f${payload}`)
    .digest("hex");
}

/** Append an entry, linking it to the book's current chain head. */
export async function appendAuditEntry(tx: Tx, input: AuditInput) {
  const previous = await tx.bookAuditEntry.findFirst({
    where: { bookId: input.bookId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { hash: true },
  });
  const createdAt = new Date();
  const prevHash = previous?.hash ?? null;
  const hash = hashAuditPayload(prevHash, canonical(input, createdAt));
  return tx.bookAuditEntry.create({
    data: {
      ...input,
      createdAt,
      prevHash,
      hash,
    },
  });
}

/** Verify a book's audit chain without mutating it. */
export async function verifyAuditChain(
  bookId: string,
): Promise<{ valid: boolean; checked: number; brokenAt?: string }> {
  const entries = await prisma.bookAuditEntry.findMany({
    where: { bookId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      bookId: true,
      entityType: true,
      entityId: true,
      action: true,
      actorId: true,
      fieldChanges: true,
      before: true,
      after: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    },
  });
  let prev: string | null = null;
  for (const entry of entries) {
    // Legacy rows written before the chain are skipped, not treated as proof
    // of tampering. Verification starts at the first hashed entry.
    if (!entry.hash) continue;
    const expected = hashAuditPayload(
      prev,
      canonical(
        {
          bookId: entry.bookId,
          entityType: entry.entityType,
          entityId: entry.entityId,
          action: entry.action,
          actorId: entry.actorId,
          fieldChanges: entry.fieldChanges,
          before: entry.before,
          after: entry.after,
        },
        entry.createdAt,
      ),
    );
    if (entry.prevHash !== prev || entry.hash !== expected) {
      return { valid: false, checked: entries.length, brokenAt: entry.id };
    }
    prev = entry.hash;
  }
  return { valid: true, checked: entries.length };
}
