import type { GstFilingCampaign } from "@/generated/prisma/client";
import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  filingChannel,
  filingGatewayHealth,
  filingGatewayPreflight,
  resolveFilingGateway,
} from "@/lib/engine/filing/gateway";
import { onceToken } from "@/lib/engine/filing/signing";
import type { FilingPreflightResult, FilingReceipt } from "@/lib/engine/filing/types";
import { gstr9InputFromCampaign, toPaise, type Gstr9CampaignInput } from "@/lib/engine/gst-filing";
import { buildEInvoicePayload, type EInvoicePayload } from "@/lib/engine/gst-returns";
import { buildGstr9, type Gstr9Result } from "@/lib/engine/gstr-9";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { assertBookTenant } from "@/lib/server/book-tenancy";
import { requireBookAccess } from "@/lib/server/gst-invoices";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Gst3bInput {
  bookId: string;
  period: string; // yyyy-mm
  /** Caller-supplied monthly ITC figures so the workspace can reconcile before filing. */
  openingIct?: number;
  itcAvailed?: number;
  itcReversed?: number;
  importIct?: number;
  rcmItc?: number;
  /** Commonly referenced monthly liability caps / checks the reviewer can verify. */
  liabilityCap?: number;
}

export interface Gstr3bResult {
  period: string;
  outward: {
    taxableValue: number;
    igst: number;
    cgst: number;
    sgst: number;
    cess: number;
    invoiceCount: number;
  };
  itc: {
    opening: number;
    availed: number;
    reversed: number;
    imports: number;
    rcm: number;
    net: number;
  };
  netLiability: number;
  /** The e-invoice payload the IRP would accept for a sample B2B invoice in this period. */
  sampleEInvoice?: EInvoicePayload;
  warnings: string[];
}

export interface FilingCampaign {
  id: string;
  bookId: string;
  gstin: string;
  formType: "gstr-1" | "gstr-3b" | "gstr-9";
  period: string;
  dueDate: string;
  signingMethod: "dsc" | "evc" | "etm";
  status: "draft" | "prepared" | "filed" | "rejected" | "error";
  ackNumber?: string | null;
  ackDate?: string | null;
  irn?: string | null;
  filedById?: string | null;
  filedAt?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type { Gstr9CampaignInput };

// Prisma stores the enum-ish form/status strings as TEXT and timestamps as
// DateTime; the wire shape uses string unions + ISO strings, so every row read
// back from the client is projected onto FilingCampaign before serialisation.
type FilingCampaignRow = Pick<
  GstFilingCampaign,
  | "id"
  | "bookId"
  | "gstin"
  | "formType"
  | "period"
  | "dueDate"
  | "signingMethod"
  | "status"
  | "ackNumber"
  | "ackDate"
  | "irn"
  | "filedById"
  | "filedAt"
  | "notes"
  | "createdAt"
  | "updatedAt"
>;

function toFilingCampaign(c: FilingCampaignRow): FilingCampaign {
  return {
    id: c.id,
    bookId: c.bookId,
    gstin: c.gstin,
    formType: c.formType as FilingCampaign["formType"],
    period: c.period,
    dueDate: c.dueDate,
    signingMethod: c.signingMethod as FilingCampaign["signingMethod"],
    status: c.status as FilingCampaign["status"],
    ackNumber: c.ackNumber,
    ackDate: c.ackDate,
    irn: c.irn,
    filedById: c.filedById,
    filedAt: c.filedAt,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gstr3bFromInvoices(
  invoices: Array<{
    invoiceNumber: string;
    taxableValue: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    invoiceType: string;
    placeOfSupply: string;
    supplierGstin: string | null;
  }>,
): Gstr3bResult["outward"] {
  let taxableValue = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let cess = 0;

  for (const inv of invoices) {
    taxableValue += inv.taxableValue;
    igst += inv.igstAmount;
    cgst += inv.cgstAmount;
    sgst += inv.sgstAmount;
    cess += inv.cessAmount;
  }

  return { taxableValue, igst, cgst, sgst, cess, invoiceCount: invoices.length };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    const book = await requireBookAccess({ workspaceId: ctx.workspace.id }, params.id);

    if (action === "gstr3b") {
      const period = url.searchParams.get("period");
      if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        return toErrorResponse(new Error("period is required and must be yyyy-mm."));
      }

      const invoices = await prisma.gstInvoice.findMany({
        where: { bookId: params.id, period, status: { in: ["validated", "posted"] } },
        orderBy: { invoiceDate: "asc" },
      });

      // Caller-supplied ITC / cap arrive as RUPEES (the API-boundary contract)
      // and are converted to integer paise so they combine with the invoice
      // outward values, which are stored in paise.
      const openingIct = toPaise(Number(url.searchParams.get("openingIct") ?? "0"));
      const itcAvailed = toPaise(Number(url.searchParams.get("itcAvailed") ?? "0"));
      const itcReversed = toPaise(Number(url.searchParams.get("itcReversed") ?? "0"));
      const importIct = toPaise(Number(url.searchParams.get("importIct") ?? "0"));
      const rcmItc = toPaise(Number(url.searchParams.get("rcmItc") ?? "0"));
      const liabilityCap = toPaise(Number(url.searchParams.get("liabilityCap") ?? "0"));

      const outward = gstr3bFromInvoices(invoices);
      const netItc = itcAvailed - itcReversed + importIct + rcmItc;
      const netLiability = outward.igst + outward.cgst + outward.sgst + outward.cess - netItc;

      const warnings: string[] = [];
      if (netLiability < 0) {
        warnings.push(
          `Net ITC (${netItc}) exceeds the outward liability (${outward.igst + outward.cgst + outward.sgst + outward.cess}) — the surplus is carried forward, not refunded on this return.`,
        );
      }
      if (liabilityCap > 0 && netLiability > liabilityCap) {
        warnings.push(
          `Net liability (${netLiability}) exceeds the commonly referenced cap (${liabilityCap}) for this period — review before filing.`,
        );
      }

      // Build a sample e-invoice payload from the first B2B invoice in the period,
      // so the workspace can preview the document the IRP would accept (honest: this
      // does not generate or verify an IRN; the IRP does that).
      const sampleEInvoice = invoices.find(
        (inv) => inv.invoiceType === "b2b" && inv.supplierGstin && inv.supplierGstin.trim() !== "",
      )
        ? buildEInvoicePayload({
            invoiceNumber: invoices.find((inv) => inv.invoiceType === "b2b")!.invoiceNumber,
            date: invoices[0]?.invoiceDate ?? new Date().toISOString().slice(0, 10),
            seller: {
              gstin: book.gstin ?? "",
              name: book.legalName ?? book.name,
              location: "Primary place of business",
              stateCode: (book.gstin ?? "").slice(0, 2),
            },
            buyer: {
              gstin: invoices.find((inv) => inv.invoiceType === "b2b" && inv.supplierGstin)?.supplierGstin ?? "",
              name: invoices.find((inv) => inv.invoiceType === "b2b")?.recipientName ?? "Buyer",
              placeOfSupply: invoices.find((inv) => inv.invoiceType === "b2b")?.placeOfSupply ?? "00",
              stateCode: invoices.find((inv) => inv.invoiceType === "b2b")?.placeOfSupply ?? "00",
            },
            supplyType: "B2B",
            items: [
              {
                description: "Sample line — preview only",
                hsn: "1234",
                taxableValue: invoices[0]?.taxableValue ?? 0,
                ratePct:
                  invoices[0] && invoices[0].taxableValue > 0
                    ? Math.round(
                        ((invoices[0].cgstAmount + invoices[0].sgstAmount + invoices[0].igstAmount) * 100) /
                          invoices[0].taxableValue,
                      )
                    : 18,
              },
            ],
          })
        : undefined;

      return ok<{ gstr3b: Gstr3bResult }>({
        gstr3b: {
          period,
          outward,
          itc: {
            opening: openingIct,
            availed: itcAvailed,
            reversed: itcReversed,
            imports: importIct,
            rcm: rcmItc,
            net: netItc,
          },
          netLiability,
          sampleEInvoice,
          warnings,
        },
      });
    }

    if (action === "campaigns") {
      const campaigns = await prisma.gstFilingCampaign.findMany({
        where: { bookId: params.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          bookId: true,
          gstin: true,
          formType: true,
          period: true,
          dueDate: true,
          signingMethod: true,
          status: true,
          ackNumber: true,
          ackDate: true,
          irn: true,
          filedById: true,
          filedAt: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return ok<{ campaigns: FilingCampaign[] }>({ campaigns: campaigns.map(toFilingCampaign) });
    }

    if (action === "gateway-health") {
      // Readiness for the filing gateway — active provider, per-channel live
      // capability and what would be needed to go live. Surfaces on every book
      // so a practice can see exactly where its portal execution stands.
      return ok<{ health: ReturnType<typeof filingGatewayHealth> }>({ health: filingGatewayHealth() });
    }

    return toErrorResponse(
      new Error(
        "Unknown action. Use action=gstr3b, action=campaigns, or action=gateway-health (POST action=gstr9 for the annual return).",
      ),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const book = await requireBookAccess({ workspaceId: ctx.workspace.id }, params.id);

    if (action === "gstr9") {
      // GSTR-9 is prepared from caller-supplied aggregates (the book stores
      // invoices, not monthly 3B figures), so it carries a request body and
      // therefore lives on POST — a GET cannot carry one. Money is RUPEES here
      // and is converted to integer paise by gstr9InputFromCampaign.
      const body = await readJsonBody<Gstr9CampaignInput>(request);
      if (!body || !body.fy || !/^\d{4}-\d{2}$/.test(body.fy)) {
        return toErrorResponse(new Error("fy is required and must be yyyy-yy."));
      }
      if (!Array.isArray(body.monthlyOutward) || body.monthlyOutward.length === 0) {
        return toErrorResponse(new Error("monthlyOutward must be a non-empty array of period aggregates."));
      }
      if (!Array.isArray(body.monthlyItcAvailed) || body.monthlyItcAvailed.length === 0) {
        return toErrorResponse(
          new Error("monthlyItcAvailed must be a non-empty array (a single annual row is allowed)."),
        );
      }
      if (!book.gstin) {
        return toErrorResponse(new Error("The book has no GSTIN — set it on the book before preparing GSTR-9."));
      }

      const result = buildGstr9(gstr9InputFromCampaign(body));

      return ok<{ gstr9: Gstr9Result; gstin: string }>({
        gstr9: result,
        gstin: book.gstin,
      });
    }

    if (action === "gateway-preflight") {
      // Verify the live credential handshake WITHOUT filing anything. It makes
      // a network call (hence POST), but creates no IRN and lodges no return —
      // the safe way to prove credentials before the first live filing.
      const preflight = await filingGatewayPreflight();
      return ok<{ preflight: FilingPreflightResult }>({ preflight });
    }

    return toErrorResponse(new Error("Unknown action. POST supports action=gstr9 and action=gateway-preflight."));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    await requireBookAccess({ workspaceId: ctx.workspace.id }, params.id);
    const body = await readJsonBody<{ action: string; [key: string]: unknown }>(request);
    const action = body.action;

    if (action === "filing-campaign") {
      const gstin = String(body.gstin ?? "").trim();
      const formType = (body.formType as FilingCampaign["formType"]) ?? "gstr-3b";
      const period = String(body.period ?? "").trim();
      const dueDate = String(body.dueDate ?? "").trim();
      const signingMethod = (body.signingMethod as FilingCampaign["signingMethod"]) ?? "evc";
      const notes = body.notes ? String(body.notes) : undefined;

      if (!gstin) return toErrorResponse(new Error("gstin is required."));
      if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        return toErrorResponse(new Error("period is required and must be yyyy-mm."));
      }
      if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return toErrorResponse(new Error("dueDate is required and must be yyyy-mm-dd."));
      }

      const campaign = await prisma.gstFilingCampaign.create({
        data: {
          bookId: params.id,
          gstin,
          formType,
          period,
          dueDate,
          signingMethod,
          status: "draft",
          notes,
          createdById: ctx.user.id,
        },
      });

      return ok<{ campaign: FilingCampaign }>({ campaign: toFilingCampaign(campaign) });
    }

    if (action === "update-campaign") {
      const campaignId = String(body.campaignId ?? "").trim();
      if (!campaignId) return toErrorResponse(new Error("campaignId is required."));

      const campaign = await prisma.gstFilingCampaign.findFirst({
        where: { id: campaignId, bookId: params.id },
      });
      if (!campaign) return toErrorResponse(new Error("Campaign not found."));

      const updated = await prisma.gstFilingCampaign.update({
        where: { id: campaignId },
        data: {
          status: (body.status as FilingCampaign["status"]) ?? campaign.status,
          ackNumber: body.ackNumber != null ? String(body.ackNumber) : campaign.ackNumber,
          ackDate: body.ackDate != null ? String(body.ackDate) : campaign.ackDate,
          irn: body.irn != null ? String(body.irn) : campaign.irn,
          notes: body.notes != null ? String(body.notes) : campaign.notes,
        },
      });

      return ok<{ campaign: FilingCampaign }>({ campaign: toFilingCampaign(updated) });
    }

    if (action === "submit-campaign") {
      // Execute the actual filing through the active gateway. The provider is
      // chosen by FILING_GATEWAY (reference default → simulation → live with
      // credentials); the receipt (IRN / acknowledgement / rejection) flows
      // straight into the campaign record so the workspace trails the return
      // to its portal acknowledgement.
      const campaignId = String(body.campaignId ?? "").trim();
      if (!campaignId) return toErrorResponse(new Error("campaignId is required."));

      const campaign = await prisma.gstFilingCampaign.findFirst({
        where: { id: campaignId, bookId: params.id },
      });
      if (!campaign) return toErrorResponse(new Error("Campaign not found."));

      const gateway = resolveFilingGateway();
      const channel = filingChannel();
      const receipt: FilingReceipt = await gateway.submit({
        channel,
        token: onceToken(),
        gstin: campaign.gstin,
        ay: campaign.formType === "gstr-9" ? campaign.period : undefined,
        payload: {
          gstin: campaign.gstin,
          formType: campaign.formType,
          period: campaign.period,
          dueDate: campaign.dueDate,
          signingMethod: campaign.signingMethod,
        },
      });

      const status: FilingCampaign["status"] =
        receipt.status === "filed"
          ? "filed"
          : receipt.status === "accepted-pending"
            ? "prepared"
            : receipt.status === "rejected"
              ? "rejected"
              : "error";

      const updated = await prisma.gstFilingCampaign.update({
        where: { id: campaignId },
        data: {
          status,
          ackNumber: receipt.ackNumber ?? campaign.ackNumber,
          ackDate: receipt.ackDate ?? campaign.ackDate,
          irn: receipt.irn ?? campaign.irn,
          filedById: receipt.status === "filed" ? ctx.user.id : campaign.filedById,
          filedAt: receipt.status === "filed" ? receipt.submittedAt : campaign.filedAt,
          notes: receipt.portalMessage
            ? `${campaign.notes ? `${campaign.notes} · ` : ""}${receipt.portalMessage}`.slice(0, 1000)
            : campaign.notes,
        },
      });

      return ok<{ receipt: FilingReceipt; campaign: FilingCampaign }>({ receipt, campaign: toFilingCampaign(updated) });
    }

    return toErrorResponse(
      new Error("Unknown action. Use action=filing-campaign, action=update-campaign, or action=submit-campaign."),
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
