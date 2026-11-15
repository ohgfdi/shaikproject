/**
 * Oracle tests for streaming CSV ingest (ROADMAP 1.5).
 *
 * The contract: ingest of very large CSVs must run in memory bounded by
 * O(columns) + capped samples/values — never O(rows). These tests pin the
 * pure pieces (header scan, row streaming, type-inference parity between the
 * streaming and materialized paths) with hand-computed fixtures on real temp
 * files.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inferType } from "@/lib/engine/dataset";
import { parseAndProfileFile, scanCsvHeader, streamCsvRows } from "@/lib/file/parse";

let dir: string;
let counter = 0;
async function tempCsv(content: string): Promise<string> {
  dir ??= await mkdtemp(path.join(tmpdir(), "Ledgerly-ingest-"));
  counter += 1;
  const p = path.join(dir, `t${counter}.csv`);
  await writeFile(p, content, "utf8");
  return p;
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("scanCsvHeader (pass 1)", () => {
  it("returns sanitized headers and bounded samples without retaining rows", async () => {
    const file = await tempCsv("name,qty,when\nalpha,1,2024-01-01\nbeta,2,2024-01-02\n");
    const { headers, samples, tooManyColumns } = await scanCsvHeader(file);
    expect(headers).toEqual(["name", "qty", "when"]);
    expect(samples[0]).toEqual(["alpha", "beta"]);
    expect(samples[1]).toEqual(["1", "2"]);
    expect(samples[2]).toEqual(["2024-01-01", "2024-01-02"]);
    expect(tooManyColumns).toBe(false);
  });

  it("flags rows wider than the header", async () => {
    const file = await tempCsv("a,b\n1,2,3\n");
    const { tooManyColumns } = await scanCsvHeader(file);
    expect(tooManyColumns).toBe(true);
  });

  it("rejects a file with no usable header row", async () => {
    const file = await tempCsv(",\n,\n");
    await expect(scanCsvHeader(file)).rejects.toThrow(/no usable header row/);
  });
});

describe("streamCsvRows (pass 2)", () => {
  it("streams every data row in order, trimmed/blank to null", async () => {
    const file = await tempCsv("a,b\n1, x \n,y\n3,z\n");
    const rows: (string | null)[][] = [];
    const { rowCount, tooManyColumns } = await streamCsvRows(file, ["a", "b"], 1000, (row) =>
      rows.push(row.map((c) => (c === null ? null : String(c)))),
    );
    expect(rowCount).toBe(3);
    expect(rows).toEqual([
      ["1", "x"],
      [null, "y"],
      ["3", "z"],
    ]);
    expect(tooManyColumns).toBe(false);
  });

  it("stops at maxRows (the honest cap)", async () => {
    const rows = ["a,b"];
    for (let i = 1; i <= 100; i++) rows.push(`${i},${i * 2}`);
    const file = await tempCsv(rows.join("\n"));
    const collected: number[] = [];
    const { rowCount } = await streamCsvRows(file, ["a", "b"], 25, (row) => collected.push(Number(row[0])));
    expect(rowCount).toBe(25);
    expect(collected).toHaveLength(25);
    expect(collected[24]).toBe(25);
  });

  it("reports a header drift note when the header changes between passes", async () => {
    // The scan sees header A; a second write (simulating a file rewritten
    // mid-ingest) gives pass 2 a different header. The mismatch is surfaced,
    // never silently misaligned.
    const file = await tempCsv("a,b\n1,2\n");
    const { headerNote } = await streamCsvRows(file, ["a", "b", "c"], 1000, () => undefined);
    expect(headerNote).toMatch(/misaligned/);
  });
});

describe("type inference parity", () => {
  it("the streaming samples feed the same inferType as the materialized path", async () => {
    const file = await tempCsv("qty,when,tag\n1,2024-01-01,x\n2,2024-01-02,y\n3,2024-01-03,x\n");
    const { samples } = await scanCsvHeader(file);
    expect(inferType(samples[0] ?? [])).toBe("number");
    expect(inferType(samples[1] ?? [])).toBe("date");
    expect(inferType(samples[2] ?? [])).toBe("string");
  });

  /**
   * Regression: the full upload pipeline DROPPED pass 1's samples on the way to
   * writeNdjsonAndProfile, so inferType() saw an empty sample and declared every
   * uploaded CSV column a string. Downstream that surfaced as `sum(VARCHAR)`
   * binder errors in SQL Lab and "Target revenue is not numeric" in the trainer.
   * The parity test above could not catch it — it never exercised the wiring.
   */
  it("parseAndProfileFile types the streaming CSV path from pass 1's samples", async () => {
    const file = await tempCsv("region,qty,when,tag\nEast,1,2024-01-01,x\nWest,2,2024-01-02,y\nEast,3,2024-01-03,x\n");
    const parsed = await withServerEnv(async () =>
      parseAndProfileFile({
        id: `ingest-types-${counter}`,
        filePath: file,
        fileName: "typed.csv",
        mimeType: "text/csv",
      }),
    );
    const byName = new Map(parsed.columns.map((c) => [c.name, c.type]));
    expect(byName.get("region")).toBe("string");
    expect(byName.get("qty")).toBe("number");
    expect(byName.get("when")).toBe("date");
    expect(byName.get("tag")).toBe("string");
    // Values are re-cast to the declared type in the NDJSON the engines read.
    expect(parsed.preview?.[0]?.[1]).toBe(1);
  });
});

/** parseAndProfileFile writes under dataDir(), which needs a valid server env. */
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
