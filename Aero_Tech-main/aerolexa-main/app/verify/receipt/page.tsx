import { PageHeader } from "@/components/layout/page-header";
import { ReceiptVerifier } from "@/components/verify/receipt-verifier";

export const metadata = { title: "Verify an approval receipt" };

/**
 * Public, account-free receipt verification. A client or auditor holding a
 * receipt can check it without signing in; the endpoint stores nothing.
 */
export default function VerifyReceiptPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader
        title="Verify an approval receipt"
        description="Paste a client approval receipt to recompute its digest and inspect the evidence. This checks what was stored and signed; it is not a legal opinion."
      />
      <div className="mt-6">
        <ReceiptVerifier />
      </div>
    </div>
  );
}
