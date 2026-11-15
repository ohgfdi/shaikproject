import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { deserializeSupplier, initiateOnboarding } from "@/lib/engine/gst-supplier-onboarding";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/gst/suppliers/onboarding/initiate — initiate onboarding workflow
 */
export async function POST(request: Request) {
  try {
    await requireAuth();

    const body = z
      .object({
        supplier: z
          .object({
            id: z.string(),
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
            constitution: z.enum([
              "proprietorship",
              "partnership",
              "company",
              "llp",
              "huf",
              "trust",
              "government",
              "other",
            ]),
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
          })
          .partial({ id: true }),
        actorId: z.string(),
      })
      .parse(await readJsonBody(request));

    const workflow = initiateOnboarding(deserializeSupplier(body.supplier), body.actorId);

    return ok({ workflow });
  } catch (err) {
    return toErrorResponse(err);
  }
}
