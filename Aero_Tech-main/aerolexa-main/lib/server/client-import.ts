/**
 * Bulk client import persistence.
 *
 * Creates one engagement and one compliance profile per validated row, inside a
 * single interactive transaction: a half-imported client book is worse than a
 * rejected file. All errors are returned before anything is written.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseClientImportCsv, type ClientImportError } from "@/lib/engine/client-import";
import { financialYearFor, type ClientComplianceProfileInput } from "@/lib/engine/compliance-calendar";
import { requireOrgRole } from "@/lib/server/members";

const MAX_ROWS = 200;

export interface ClientImportResult {
  created: Array<{ id: string; name: string; code: string | null }>;
  warnings: string[];
}

export async function importClientsFromCsv(ctx: AuthContext, csv: string): Promise<ClientImportResult> {
  const organization = ctx.organization;
  if (!organization) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }
  await requireOrgRole(ctx, organization.id, "MEMBER");

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseClientImportCsv(csv, { defaultFinancialYear: financialYearFor(today) });
  if (parsed.rows.length > MAX_ROWS) {
    throw new ApiError(400, "CLIENT_IMPORT_TOO_LARGE", `Import at most ${MAX_ROWS} clients per file.`);
  }

  const errors: ClientImportError[] = [...parsed.errors];
  const codes = parsed.rows.map((row) => row.code).filter((code): code is string => Boolean(code));
  const existing = codes.length
    ? await prisma.engagement.findMany({
        where: { organizationId: organization.id, code: { in: codes } },
        select: { code: true },
      })
    : [];
  const taken = new Set(existing.map((row) => row.code));
  for (const row of parsed.rows) {
    if (row.code && taken.has(row.code)) {
      errors.push({ line: row.line, message: `Client code "${row.code}" already exists in this firm.` });
    }
  }

  if (errors.length > 0) {
    throw new ApiError(
      400,
      "CLIENT_IMPORT_INVALID",
      `${errors.length} row${errors.length === 1 ? "" : "s"} failed validation; nothing was imported.`,
      { errors: errors.slice(0, 100) },
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const result: Array<{ id: string; name: string; code: string | null }> = [];
    for (const row of parsed.rows) {
      const engagement = await tx.engagement.create({
        data: {
          organizationId: organization.id,
          name: row.name,
          code: row.code,
          gstin: row.gstin,
          description: "Imported from client list.",
        },
        select: { id: true, name: true, code: true },
      });
      const seed: Omit<ClientComplianceProfileInput, "clientId" | "clientName"> = {
        entityKind: row.entityKind,
        financialYear: row.financialYear,
        gstRegistered: row.gstRegistered,
        gstFrequency: row.gstFrequency,
        tdsDeductor: row.tdsDeductor,
        taxAuditApplicable: row.taxAuditApplicable,
        transferPricingApplicable: false,
        listedCompany: false,
        state: row.state,
        employsStaff: row.employsStaff,
      };
      await tx.clientComplianceProfile.create({
        data: {
          organizationId: organization.id,
          engagementId: engagement.id,
          profile: JSON.stringify(seed),
          createdById: ctx.user.id,
          updatedById: ctx.user.id,
        },
      });
      result.push(engagement);
    }
    return result;
  });

  return {
    created,
    warnings: [
      "No portal invitations were sent. Add client contacts and invite them from each engagement when ready.",
      "Review imported GSTINs and states against the client's registration before relying on the calendar.",
    ],
  };
}
