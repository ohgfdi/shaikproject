// C20 — ITC reconciliation against an INDEPENDENT oracle.
//
// The expected values below are computed in this file from the fixture rows by
// plain JavaScript. Nothing here imports lib/engine, so the app cannot produce
// its own expected value. Amounts are rupees in the fixture and paise in the
// response; the oracle works in paise.
import fs from "node:fs";
import path from "node:path";
import { BASE_URL, ROOT, login, saveJson } from "./lib.mjs";
import { chromium } from "playwright";

const TWO_B = [
  {
    gstin: "27AAPFU0939F1ZV",
    supplierName: "Alpha Traders",
    invoiceNumber: "INV-001",
    invoiceDate: "2026-09-01",
    taxableValue: 1000,
    igst: 180,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "27",
    supplierFiledGstr1: true,
  },
  {
    gstin: "29AABCU9603R1ZM",
    supplierName: "Beta Supplies",
    invoiceNumber: "INV-002",
    invoiceDate: "2026-09-05",
    taxableValue: 2000,
    igst: 0,
    cgst: 180,
    sgst: 180,
    placeOfSupply: "29",
    supplierFiledGstr1: true,
  },
  {
    gstin: "27AAACR5055K1Z1",
    supplierName: "Gamma Services",
    invoiceNumber: "INV-003",
    invoiceDate: "2026-09-10",
    taxableValue: 500,
    igst: 90,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "27",
    supplierFiledGstr1: true,
  },
  {
    gstin: "27AACCM1234A1Z5",
    supplierName: "Delta Motors",
    invoiceNumber: "INV-005",
    invoiceDate: "2026-09-15",
    taxableValue: 1000,
    igst: 180,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "27",
    supplierFiledGstr1: true,
  },
];

const PURCHASES = [
  {
    gstin: "27AAPFU0939F1ZV",
    invoiceNumber: "INV-001",
    invoiceDate: "2026-09-01",
    taxableValue: 1000,
    igst: 180,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "27",
  },
  {
    gstin: "29AABCU9603R1ZM",
    invoiceNumber: "INV-002",
    invoiceDate: "2026-09-05",
    taxableValue: 2000,
    igst: 0,
    cgst: 180,
    sgst: 180,
    placeOfSupply: "29",
  },
  {
    gstin: "27AACCM1234A1Z5",
    invoiceNumber: "INV-005",
    invoiceDate: "2026-09-15",
    taxableValue: 1000,
    igst: 90,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "27",
  },
  {
    gstin: "24AAACC1206D1ZM",
    invoiceNumber: "INV-004",
    invoiceDate: "2026-09-12",
    taxableValue: 800,
    igst: 144,
    cgst: 0,
    sgst: 0,
    placeOfSupply: "24",
  },
];

const key = (r) => `${r.gstin}|${r.invoiceNumber}|INV`;
const sumTax = (r) => (r.igst + r.cgst + r.sgst + (r.cess ?? 0)) * 100;

// --- oracle -----------------------------------------------------------------
const twoBByKey = new Map(TWO_B.map((r) => [key(r), r]));
const matched = [];
const booksOnly = [];
const usedTwoB = new Set();
for (const p of PURCHASES) {
  const twin = twoBByKey.get(key(p));
  if (twin && !usedTwoB.has(key(twin))) {
    usedTwoB.add(key(twin));
    matched.push({ purchase: p, twin });
  } else {
    booksOnly.push(p);
  }
}
const twoBOnly = TWO_B.filter((r) => !usedTwoB.has(key(r)));
const withinTolerance = (a, b) => Math.abs(sumTax(a) - sumTax(b)) <= 100; // ₹1 default tolerance
const eligible = matched.filter((m) => withinTolerance(m.purchase, m.twin));
const mismatched = matched.filter((m) => !withinTolerance(m.purchase, m.twin));

const expectedCounts = {
  "matched-eligible": eligible.length,
  "matched-eligible-rcm": 0,
  "matched-blocked": 0,
  "matched-rule37": 0,
  "matched-expired-s16": 0,
  "amount-mismatch": mismatched.length,
  "in-2b-only": twoBOnly.length,
  "in-books-only": booksOnly.length,
};

const sumPaise = (rows) =>
  rows.reduce(
    (acc, r) => ({
      taxableValue: acc.taxableValue + r.taxableValue * 100,
      igst: acc.igst + r.igst * 100,
      cgst: acc.cgst + r.cgst * 100,
      sgst: acc.sgst + r.sgst * 100,
      cess: acc.cess + (r.cess ?? 0) * 100,
    }),
    { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
  );

const expectedTable4 = {
  itcAvailed: sumPaise(eligible.map((m) => m.twin)),
  pending2b: sumPaise(booksOnly),
};

// --- call the API -----------------------------------------------------------
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await login(context);
const response = await context.request.post(`${BASE_URL}/api/gst/itc-recon`, {
  data: { asOfDate: "2026-10-19", tolerance: 1, twoB: TWO_B, purchases: PURCHASES },
});
const status = response.status();
const payload = await response.json();
await browser.close();

const actual = payload?.data?.reconciliation;
const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok, detail });

if (!actual) {
  saveJson("evidence/C20-itc-oracle.json", {
    status,
    payload,
    expectedCounts,
    checks: [{ name: "response", ok: false, detail: JSON.stringify(payload).slice(0, 400) }],
  });
  console.log(JSON.stringify({ ok: false, status, payload: JSON.stringify(payload).slice(0, 400) }, null, 2));
  process.exit(1);
}

push("http 200", status === 200, `status=${status}`);
for (const [verdict, expected] of Object.entries(expectedCounts)) {
  push(`count ${verdict}=${expected}`, actual.counts[verdict] === expected, `actual=${actual.counts[verdict]}`);
}
push(
  "table4 itcAvailed",
  JSON.stringify(actual.table4.itcAvailed) === JSON.stringify(expectedTable4.itcAvailed),
  `expected=${JSON.stringify(expectedTable4.itcAvailed)} actual=${JSON.stringify(actual.table4.itcAvailed)}`,
);
push(
  "table4 pending2b (books-only ITC held back)",
  JSON.stringify(actual.table4.pending2b) === JSON.stringify(expectedTable4.pending2b),
  `expected=${JSON.stringify(expectedTable4.pending2b)} actual=${JSON.stringify(actual.table4.pending2b)}`,
);
// Independent invariant: net = availed + rcm - reversed, per head.
const t4 = actual.table4;
for (const head of ["igst", "cgst", "sgst", "cess"]) {
  const expectedNet = t4.itcAvailed[head] + t4.itcAvailedRcm[head] - t4.itcReversed[head];
  push(`4(C)=4(A)-4(B) ${head}`, t4.netItc[head] === expectedNet, `expected=${expectedNet} actual=${t4.netItc[head]}`);
}
// Independent invariant: the books-only invoice's tax is nowhere in 4(A).
const booksOnlyTax = expectedTable4.pending2b.igst;
push(
  "books-only IGST not availed in 4(A)",
  t4.itcAvailed.igst === expectedTable4.itcAvailed.igst,
  `4(A).igst=${t4.itcAvailed.igst}, books-only=${booksOnlyTax}`,
);

const artifact = {
  fixture: { twoB: TWO_B, purchases: PURCHASES, asOfDate: "2026-10-19", tolerance: 1 },
  oracle: { expectedCounts, expectedTable4 },
  response: { status, counts: actual.counts, table4: actual.table4 },
  checks,
  ok: checks.every((c) => c.ok),
};
saveJson("evidence/C20-itc-oracle.json", artifact);
console.log(JSON.stringify({ ok: artifact.ok, failed: checks.filter((c) => !c.ok) }, null, 2));
process.exit(artifact.ok ? 0 : 1);
