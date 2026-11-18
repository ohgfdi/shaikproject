import { prepareITRInEnglish } from '@/lib/ai/itr-preparation';
import { requireAuth } from '@/lib/auth/guard';
import { ok, toErrorResponse } from '@/lib/server/api';

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();

    const body = await request.json();
    const {
      type,
      clientName,
      financialYear,
      totalIncome,
      salaryComponents: _salaryComponents,
      deductions,
      investments,
      taxesPaid: _taxesPaid,
      entityKind,
    } = body as {
      type: 'prepare-itr' | 'tax-query' | 'tax-planning';
      clientName?: string;
      financialYear?: string;
      totalIncome?: string;
      salaryComponents?: {
        basic: string;
        hra: string;
        allowances: string;
        perquisites: string;
      };
      deductions?: {
        section80C: string;
        section80D: string;
        homeLoanInterest: string;
        otherDeductions: string;
      };
      investments?: {
        ppf: string;
        equity: string;
        mutualFunds: string;
        otherInvestments: string;
      };
      taxesPaid?: {
        tds: string;
        advanceTax: string;
        selfAssessmentTax: string;
      };
      entityKind?: 'individual' | 'HUF' | 'company' | 'firm' | 'LLP';
    };

    switch (type) {
      case 'prepare-itr': {
        if (!clientName || !financialYear || !totalIncome) {
          return toErrorResponse(
            new Error('Missing required: clientName, financialYear, totalIncome')
          );
        }

        const result = await prepareITRInEnglish({
          clientName,
          financialYear,
          totalIncome,
          entityKind: entityKind || 'individual',
        });

        return ok({
          type: 'itr-preparation',
          result,
          generatedAt: new Date().toISOString(),
          generatedBy: ctx.user?.id || 'unknown',
        });
      }

      case 'tax-query': {
        if (!clientName || !financialYear) {
          return toErrorResponse(
            new Error('Missing required: clientName, financialYear')
          );
        }

        // Simple tax query response using rule-based engine
        const taxableIncome = parseInt(totalIncome || "0");
        const taxLiability = Math.round(taxableIncome * 0.3);

        return ok({
          type: 'tax-query',
          question: `${clientName} — FY ${financialYear}, income ₹${totalIncome}`,
          computation: {
            grossIncome: totalIncome,
            taxRate: "30% (simplified)",
            taxLiability,
            notes: "This is a demo calculation. Consult official tax slabs for accurate computation.",
          },
          answeredAt: new Date().toISOString(),
          answeredBy: ctx.user?.id || 'unknown',
        });
      }

      case 'tax-planning': {
        if (!clientName || !financialYear) {
          return toErrorResponse(
            new Error('Missing required: clientName, financialYear')
          );
        }

        const planningTips: string[] = [];

        if (deductions?.section80C) {
          planningTips.push(
            `Maximize 80C investments (currently ₹${deductions.section80C}/₹1.5L) — PPF, EPF, LIC, ELSS`
          );
        }

        if (deductions?.homeLoanInterest) {
          planningTips.push(
            `Home loan interest deduction — ensure timely EMI payment & certificate`
          );
        }

        if (investments?.ppf) {
          planningTips.push(
            `PPF contribution ₹${investments.ppf} — EEE tax status, 15-year lock`
          );
        }

        return ok({
          type: 'tax-planning',
          client: clientName,
          financialYear,
          planningTips,
          generatedAt: new Date().toISOString(),
          generatedBy: ctx.user?.id || 'unknown',
        });
      }

      default:
        return toErrorResponse(new Error(`Unknown AI type: ${type}`));
    }
  } catch (err: unknown) {
    return toErrorResponse(err);
  }
}