import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import {
  buildNoticeWorklist,
  type GstNotice,
  type ReconciliationArtifact,
  type NoticeResponse,
} from "@/lib/engine/gst-notice-workflow";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
export const dynamic = "force-dynamic";
/**
 * POST /api/gst/notices/worklist — build prioritized notice worklist
 */
export async function POST(request: Request) {
  try {
    await requireAuth();
    const noticeSchema = z.object({
      id: z.string(),
      noticeNumber: z.string(),
      noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      noticeType: z.enum([
        "asmt-10",
        "asmt-14",
        "drc-01",
        "drc-03",
        "cmp-08",
        "cmp-09",
        "adt-01",
        "adt-02",
        "rfd-01",
        "reg-17",
        "anti-profiteering",
        "e-way-bill",
        "gstr-2b-mismatch",
        "gstr-1-3b-mismatch",
        "itc-reversal",
        "other",
      ]),
      authorityLevel: z.enum([
        "proper-officer",
        "jc",
        "ac",
        "dc",
        "commissioner",
        "aat",
        "high-court",
        "supreme-court",
      ]),
      authorityName: z.string(),
      authorityJurisdiction: z.string(),
      gstin: z.string().trim().min(15).max(15),
      entityName: z.string(),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
      financialYear: z.string().optional(),
      subject: z.string(),
      description: z.string(),
      sections: z.array(z.string()),
      rules: z.array(z.string()),
      demandedAmount: z
        .object({
          tax: z.number().finite().multipleOf(0.01).safe(),
          interest: z.number().finite().multipleOf(0.01).safe(),
          penalty: z.number().finite().multipleOf(0.01).safe(),
          total: z.number().finite().multipleOf(0.01).safe(),
        })
        .optional(),
      responseDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum([
        "received",
        "under-review",
        "response-drafting",
        "response-filed",
        "personal-hearing",
        "order-received",
        "appeal-filed",
        "closed",
        "escalated",
      ]),
      assignedTo: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]),
      tags: z.array(z.string()),
      createdAt: z.string(),
      updatedAt: z.string(),
    });
    const artifactSchema = z.object({
      type: z.enum([
        "gstr-2b-recon",
        "gstr-1-3b-recon",
        "supplier-recon",
        "rcm-recon",
        "export-lut",
        "e-way-bill",
        "itc-reversal",
      ]),
      period: z.string().regex(/^\d{4}-\d{2}$/),
      entityId: z.string(),
      bookId: z.string().optional(),
      summary: z.object({
        totalMismatches: z.number(),
        totalTaxImpact: z.number(),
        keyFindings: z.array(z.string()),
      }),
      details: z.object({
        invoices: z
          .array(
            z.object({
              invoiceNumber: z.string(),
              gstin: z.string(),
              issue: z.string(),
              taxImpact: z.number(),
            }),
          )
          .optional(),
        blockedItc: z.array(
          z.object({
            category: z.string(),
            amount: z.number(),
            section: z.string(),
          }),
        ),
        missingInvoices: z.array(
          z.object({
            count: z.number(),
            estimatedTax: z.number(),
          }),
        ),
        rateMismatches: z.array(
          z.object({
            expectedRate: z.number(),
            actualRate: z.number(),
          }),
        ),
        quantityMismatches: z.array(
          z.object({
            expectedQty: z.number(),
            actualQty: z.number(),
          }),
        ),
        rcmLiability: z.array(
          z.object({
            taxableValue: z.number(),
            tax: z.number(),
          }),
        ),
        exportDetails: z.array(
          z.object({
            shippingBill: z.string(),
            date: z.string(),
          }),
        ),
      }),
      generatedAt: z.string(),
      generatedBy: z.string(),
    });
    const responseSchema = z.object({
      id: z.string().optional(),
      noticeId: z.string(),
      responseNumber: z.string(),
      responseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      responseType: z.enum(["reply", "clarification", "payment", "appeal", "rectification", "hearing-request"]),
      draftedBy: z.string(),
      reviewedBy: z.string().optional(),
      approvedBy: z.string().optional(),
      status: z.enum(["draft", "reviewed", "approved", "filed", "withdrawn"]),
      content: z.object({
        facts: z.string(),
        legalArguments: z.array(z.string()),
        evidenceReferences: z.array(z.string()),
        computations: z.array(
          z.object({
            head: z.string(),
            demanded: z.number(),
            admitted: z.number(),
            disputed: z.number(),
            basis: z.string(),
          }),
        ),
        prayers: z.array(z.string()),
        attachments: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["reconciliation", "invoice", "ledger", "bank", "contract", "correspondence", "other"]),
            ref: z.string(),
          }),
        ),
      }),
      filedDate: z.string().optional(),
      filingMode: z.enum(["portal", "physical", "email"]),
      acknowledgmentRef: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    });
    const body = z
      .object({
        notices: z.array(noticeSchema),
        artifacts: z.array(artifactSchema),
        responses: z.array(responseSchema).optional(),
      })
      .parse(await readJsonBody(request));
    const responsesMap = new Map<string, NoticeResponse>();
    if (body.responses) {
      for (const r of body.responses) {
        responsesMap.set(r.noticeId, {
          id: r.id ?? `resp-${r.noticeId}-${r.responseNumber}`,
          noticeId: r.noticeId,
          responseNumber: r.responseNumber,
          responseDate: r.responseDate,
          responseType: r.responseType,
          draftedBy: r.draftedBy,
          reviewedBy: r.reviewedBy,
          approvedBy: r.approvedBy,
          status: r.status,
          content: r.content,
          attachments: r.content.attachments,
          filedDate: r.filedDate,
          filingMode: r.filingMode,
          acknowledgmentRef: r.acknowledgmentRef,
          createdAt: r.createdAt ?? r.responseDate,
          updatedAt: r.updatedAt ?? r.responseDate,
        });
      }
    }
    const worklist = buildNoticeWorklist(
      body.notices as GstNotice[],
      body.artifacts as ReconciliationArtifact[],
      responsesMap,
    );
    return ok({ worklist });
  } catch (err) {
    return toErrorResponse(err);
  }
}
