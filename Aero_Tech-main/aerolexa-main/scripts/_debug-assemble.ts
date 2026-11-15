import { assemble, buildCertificatePartBody } from "@/lib/engine/deliverable-assembly";

const TEMPLATE_BODY = JSON.stringify({
  cover: { title: "Balance Sheet of ^^CLIENT_NAME^^", subtitle: "FY 2025-26", docRef: "^^FIRM_NAME^^" },
  parts: [
    { kind: "body", heading: "Balance Sheet", body: "GSTIN of the entity is ^^GSTIN^^." },
    { kind: "note", heading: "Note 1 — Accounting policies", body: "Basis of preparation." },
  ],
  precedents: [],
});

async function main() {
  const template = {
    id: "tpl",
    formatCode: "BALANCE_SHEET",
    body: TEMPLATE_BODY,
    notes: null,
  } as never;
  const format = { clauses: JSON.stringify({ "SA 700": "Opinion" }) } as never;

  try {
    const out = await assemble({
      template,
      format,
      computedBody: "Total assets 1,00,000",
      workingPapers: [],
      renderOpts: {
        variant: "CLIENT",
        placeholders: { CLIENT_NAME: "Acme Industries", GSTIN: "27AAABC1234A1Z5", FIRM_NAME: "Acme & Co" },
      },
      certificate: buildCertificatePartBody(undefined, {
        variant: "CLIENT",
        placeholders: { CLIENT_NAME: "Acme Industries", GSTIN: "27AAABC1234A1Z5", FIRM_NAME: "Acme & Co" },
      }),
      supplementaryParts: [],
    });
    console.log("OK parts:", out.parts.length, "hash:", out.contentHash);
  } catch (err) {
    console.error("ASSEMBLE THREW:", err);
    process.exit(1);
  }
}

main();
