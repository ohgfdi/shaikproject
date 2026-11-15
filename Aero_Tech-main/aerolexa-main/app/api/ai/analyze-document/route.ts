import { requireAuth } from '@/lib/auth/guard';
import { prisma } from '@/lib/db';
import { ok, toErrorResponse } from '@/lib/server/api';

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();

    const body = await request.json();
    const { documentType, content, title } = body;

    if (!documentType || !content) {
      return toErrorResponse(new Error('Missing required: documentType, content'));
    }

    if (title.length < 3) {
      return toErrorResponse(new Error('Title must be at least 3 characters'));
    }

    // Document-aware AI analysis based on category
    let analysis: any = null;

    switch (documentType) {
      case 'trial-balance': {
        const lines = content.split('\n').filter((l: string) => l.trim());
        const accounts: any[] = [];
        let totalDebit = 0;
        let totalCredit = 0;

        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 4) {
            const amountStr = parts.pop() || '0';
            const amount = parseFloat(amountStr.replace(/[$,]/g, '')) || 0;
            accounts.push({
              name: parts.join(' '),
              debit: parts.includes('Dr') || parts.includes('DR') ? amount : 0,
              credit: parts.includes('Cr') || parts.includes('CR') ? amount : 0,
            });
            if (parts.includes('Dr') || parts.includes('DR')) totalDebit += amount;
            if (parts.includes('Cr') || parts.includes('CR')) totalCredit += amount;
          }
        }

        analysis = {
          type: 'trial-balance-analysis',
          totalAccounts: accounts.length,
          totalDebit,
          totalCredit,
          isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
          accounts,
          observations: totalDebit !== totalCredit
            ? 'Trial balance does not total. Check for missing entries or posting errors.'
            : 'Trial balance is balanced.',
        };
        break;
      }

      case 'invoice': {
        const invoiceAmountMatch = content.match(/[₹$]?\s*([0-9,]+\.?[0-9]{0,2})/);
        const amount = invoiceAmountMatch ? parseFloat(invoiceAmountMatch[1].replace(/[$,]/g, '')) : null;

        let obs = 'Could not extract invoice amount.';
        let ea: number | undefined;
        if (amount !== null) {
          ea = amount;
          obs = `Invoice total: ₹${amount.toLocaleString()}`;
        }

        analysis = {
          type: 'invoice-analysis',
          documentType,
          title,
          extractedAmount: ea,
          observations: obs,
        } as any;
        break;
      }

      case 'receipt': {
        const amountMatch = content.match(/[₹$]?\s*([0-9,]+\.?[0-9]{0,2})/);
        const amount = amountMatch ? parseFloat(amountMatch[1].replace(/[$,]/g, '')) : null;

        let obs = 'Could not extract receipt amount.';
        let ea: number | undefined;
        if (amount !== null) {
          ea = amount;
          obs = `Receipt amount: ₹${amount.toLocaleString()}`;
        }

        analysis = {
          type: 'receipt-analysis',
          documentType,
          title,
          extractedAmount: ea,
          observations: obs,
        } as any;
        break;
      }

      case 'bank-statement': {
        const debitMatch = content.match(/[Dd]ebit[^\n]{0,50}/gi);
        const creditMatch = content.match(/[Cc]redit[^\n]{0,50}/gi);

        analysis = {
          type: 'bank-statement-analysis',
          documentType,
          title,
          debitCount: debitMatch ? debitMatch.length : 0,
          creditCount: creditMatch ? creditMatch.length : 0,
          observations: 'Bank statement parsed for debit/credit entries.',
        } as any;
        break;
      }

      case 'other': {
        const lowerContent = content.toLowerCase();
        const keyTerms: string[] = [];
        const financialTerms = ['gst', 'tds', 'vat', 'invoice', 'payment', 'receipt', 'balance', 'ledger'];
        for (const term of financialTerms) {
          if (lowerContent.includes(term)) {
            keyTerms.push(term);
          }
        }

        analysis = {
          type: 'generic-analysis',
          documentType,
          title,
          keyTerms,
          observations: keyTerms.length > 0 ? `Document mentions: ${keyTerms.join(', ')}` : 'Generic document analysis completed.',
        } as any;
        break;
      }

      default: {
        analysis = {
          type: 'unknown-type',
          documentType,
          title,
          observations: 'Document type recognized but no specific analysis module available.',
        } as any;
        break;
      }
    }

    return ok({
      type: 'document-analysis',
      documentType,
      title,
      analysis,
      analyzedAt: new Date().toISOString(),
      analyzedBy: ctx.user?.id || 'unknown',
    });
  } catch (err: any) {
    return toErrorResponse(err);
  }
}