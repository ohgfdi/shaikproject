import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import {
  runMonitoringChecks,
  deserializeSupplier,
  type SupplierMaster,
  DEFAULT_MONITORING_CONFIG,
} from "@/lib/engine/gst-supplier-onboarding";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/gst/suppliers/monitoring/run — run monitoring checks for a supplier
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const supplierSchema = z.object({
      id: z.string(),
      workspaceId: z.string(),
      bookId: z.string().optional(),
      gstin: z.string().trim().min(15).max(15),
      pan: z.string().trim().min(10).max(10),
      legalName: z.string().trim().min(1),
      tradeName: z.string().optional(),
      address: z.string(), // JSON
      registrationType: z.enum([
        "regular",
        "composition",
        "tcs-collector",
        "tds-deductor",
        "non-resident",
        "casual",
        "isd",
        "unknown",
      ]),
      constitution: z.enum(["proprietorship", "partnership", "company", "llp", "huf", "trust", "government", "other"]),
      registrationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cancellationDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      category: z.enum(["goods", "services", "capital-goods", "job-work", "transport", "professional", "other"]),
      primaryHsnSac: z.string().trim().min(4).max(8),
      businessDescription: z.string().optional(),
      bankAccounts: z.string(), // JSON
      contacts: z.string(), // JSON
      authorizedSignatories: z.string(), // JSON
      status: z.enum(["active", "inactive", "blocked", "pending-verification", "suspended", "cancelled"]),
      complianceRating: z.enum(["A", "B", "C", "D", "unrated"]),
      riskScore: z.number().int().min(0).max(100),
      lastValidatedAt: z.string(),
      lastFilingStatus: z.string(), // JSON
      monitoringEnabled: z.boolean(),
      monitoringFrequency: z.enum(["daily", "weekly", "monthly"]),
      alerts: z.string(), // JSON
      onboardedAt: z.string(),
      onboardedBy: z.string(),
      updatedAt: z.string(),
      updatedBy: z.string(),
    });

    const configSchema = z
      .object({
        enabled: z.boolean(),
        frequency: z.enum(["daily", "weekly", "monthly"]),
        checks: z.object({
          gstinStatus: z.boolean(),
          filingStatus: z.boolean(),
          addressChange: z.boolean(),
          coreFieldChange: z.boolean(),
          mismatchRate: z.boolean(),
          rcmLiability: z.boolean(),
          demandNotices: z.boolean(),
        }),
        thresholds: z.object({
          mismatchRatePct: z.number().min(0).max(100),
          nonFilerMonths: z.number().int().min(1).max(12),
          riskScoreIncrement: z.number().int().min(1).max(50),
        }),
      })
      .optional();

    const body = z
      .object({
        supplier: supplierSchema,
        config: configSchema,
      })
      .parse(await readJsonBody(request));

    const results = await runMonitoringChecks(
      deserializeSupplier(body.supplier) as unknown as SupplierMaster,
      body.config ?? DEFAULT_MONITORING_CONFIG,
    );

    return ok({ results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
