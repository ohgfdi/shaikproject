/**
 * Bank-statement PDF ingestion (B17) — the upload pipeline's PDF path.
 *
 * Contract: a text-layer PDF uploads end-to-end through parseAndProfileFile
 * into a typed dataset (date/description/debit/credit/balance), and a PDF
 * with no text layer (scanned/images only) is rejected with an honest,
 * actionable error instead of silently producing an empty dataset. The
 * extraction primitives (extractPdfText / pdfTextToRows) are the same ones
 * the bank-statement connector uses.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractPdfText, pdfTextToRows } from "@/lib/engine/connectors/bank-statement";
import { parseAndProfileFile, ParseError } from "@/lib/file/parse";

let dir: string;
let counter = 0;

/** A minimal single-page PDF whose content stream carries a text layer. */
function syntheticPdf(textLines: string[]): string {
  const content = `BT /F1 10 Tf 10 700 Td ${textLines.map((l) => `(${l}) Tj`).join(" ")} ET`;
  return [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${content.length} >> stream`,
    content,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
}

async function tempPdf(textLines: string[], name = "statement.pdf"): Promise<string> {
  dir ??= await mkdtemp(path.join(tmpdir(), "Ledgerly-pdf-"));
  counter += 1;
  const p = path.join(dir, `p${counter}-${name}`);
  await writeFile(p, syntheticPdf(textLines), "latin1");
  return p;
}

async function withServerEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
  process.env.DATA_DIR ??= "data/unit-test";
  process.env.AUTH_SECRET ??= "unit-test-secret-0123456789abcdefghijklmnopqrstuv";
  try {
    return await fn();
  } finally {
    process.env = prev;
  }
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("extractPdfText / pdfTextToRows primitives", () => {
  it("harvests the Tj strings from an uncompressed content stream", async () => {
    const file = await tempPdf(["01-04-2024", "UPI-RENT-PUNE", "1000.00", "0.00", "99000.00"]);
    const { readFile } = await import("node:fs/promises");
    const text = extractPdfText(await readFile(file));
    expect(text.split("\n")).toEqual(["01-04-2024", "UPI-RENT-PUNE", "1000.00", "0.00", "99000.00"]);
  });

  it("reconstructs a 3-amount row as debit/credit/balance", async () => {
    const rows = pdfTextToRows("01-04-2024\nUPI-RENT-PUNE\n1000.00\n0.00\n99000.00");
    expect(rows).toEqual([["01-04-2024", "UPI-RENT-PUNE", "1000", "0", "99000"]]);
  });

  it("reconstructs a 2-amount row with sign-decided direction", async () => {
    const credit = pdfTextToRows("02-04-2024\nNEFT-CREDIT\n5000.00\n104000.00");
    expect(credit).toEqual([["02-04-2024", "NEFT-CREDIT", "0", "5000", "104000"]]);
    const debit = pdfTextToRows("03-04-2024\nATM-WITHDRAWAL\n-2000.00\n102000.00");
    expect(debit).toEqual([["03-04-2024", "ATM-WITHDRAWAL", "2000", "0", "102000"]]);
  });

  it("returns no rows when the text has no dated row starts", () => {
    expect(pdfTextToRows("just some prose\nno dates here")).toEqual([]);
  });
});

describe("parseAndProfileFile — PDF path (B17)", () => {
  it("ingests a text-layer PDF into a typed dataset", async () => {
    const file = await tempPdf([
      "01-04-2024",
      "UPI-RENT-PUNE",
      "1000.00",
      "0.00",
      "99000.00",
      "02-04-2024",
      "NEFT-CREDIT-SALARY",
      "0.00",
      "5000.00",
      "104000.00",
    ]);
    const parsed = await withServerEnv(async () =>
      parseAndProfileFile({
        id: `pdf-ingest-${counter}`,
        filePath: file,
        fileName: "statement.pdf",
        mimeType: "application/pdf",
      }),
    );
    expect(parsed.rowCount).toBe(2);
    expect(parsed.columnCount).toBe(5);
    expect(parsed.columns.map((c) => c.name)).toEqual(["date", "description", "debit", "credit", "balance"]);
    const byName = new Map(parsed.columns.map((c) => [c.name, c.type]));
    expect(byName.get("debit")).toBe("number");
    expect(byName.get("credit")).toBe("number");
    expect(byName.get("balance")).toBe("number");
    expect(byName.get("description")).toBe("string");
    // Values are re-cast to the declared type in the NDJSON the engines read.
    expect(parsed.preview?.[0]?.[2]).toBe(1000);
    expect(parsed.preview?.[1]?.[3]).toBe(5000);
    expect(parsed.qualityWarnings.join(" ")).toMatch(/text layer/i);
  });

  it("rejects a scanned (image-only) PDF with an honest, actionable error", async () => {
    const file = await tempPdf([]); // content stream with no Tj operators at all
    await expect(
      withServerEnv(async () =>
        parseAndProfileFile({
          id: `pdf-scan-${counter}`,
          filePath: file,
          fileName: "scanned.pdf",
          mimeType: "application/pdf",
        }),
      ),
    ).rejects.toThrow(/no extractable text layer/);
  });

  it("rejects a text-layer PDF with no recognizable dated rows", async () => {
    const file = await tempPdf(["This is a notice letter, not a statement.", "No dated rows here."]);
    await expect(
      withServerEnv(async () =>
        parseAndProfileFile({
          id: `pdf-norows-${counter}`,
          filePath: file,
          fileName: "letter.pdf",
          mimeType: "application/pdf",
        }),
      ),
    ).rejects.toThrow(/No transaction rows/);
  });

  it("keeps the unsupported-type refusal for non tabular formats", async () => {
    const file = await tempPdf(["x"], "x.png");
    await expect(
      withServerEnv(async () =>
        parseAndProfileFile({
          id: `pdf-badext-${counter}`,
          filePath: file,
          fileName: "x.png",
          mimeType: "image/png",
        }),
      ),
    ).rejects.toThrow(ParseError);
  });
});
