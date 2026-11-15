/**
 * XLSX export (Gap ③) — the workbook the export endpoint streams must be a
 * real multi-sheet Excel file: Data + Profile (when a profile exists) +
 * Quality (when warnings exist) + Provenance (always), with a ReadMe-style
 * sampled flag. The endpoint's auth/role logic is exercised by the API suite;
 * here we pin the workbook shape so a SheetJS upgrade cannot silently break
 * the analyst's final mile.
 */

import * as XLSX from "xlsx";

export {};

function buildWorkbook(opts: {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  profile: { name: string; type: string; missing: number; distinct: number; outliers: number }[] | null;
  warnings: string[];
  totalRows: number;
}) {
  const wb = XLSX.utils.book_new();
  const aoa: (string | number | boolean | null)[][] = [opts.columns.map((c) => c.name), ...opts.rows];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Data");
  if (opts.profile) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["column", "type", "missing", "distinct", "outliers"],
        ...opts.profile.map((c) => [c.name, c.type, c.missing, c.distinct, c.outliers]),
      ]),
      "Profile",
    );
  }
  if (opts.warnings.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["data-quality warning"], ...opts.warnings.map((w) => [w])]),
      "Quality",
    );
  }
  const sampled = opts.totalRows > opts.rows.length;
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["field", "value"],
      ["rows in source", opts.totalRows],
      ["rows exported", opts.rows.length],
      ["sampled", sampled ? "yes — export capped at DATASET_ANALYSIS_LIMIT" : "no"],
    ]),
    "Provenance",
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("xlsx export workbook shape", () => {
  it("writes Data + Profile + Quality + Provenance sheets", () => {
    const buf = buildWorkbook({
      columns: [
        { name: "id", type: "number" },
        { name: "city", type: "string" },
      ],
      rows: [
        [1, "Pune"],
        [2, "Jaipur"],
      ],
      profile: [{ name: "id", type: "number", missing: 0, distinct: 2, outliers: 0 }],
      warnings: ["Column “city” has 10% missing values."],
      totalRows: 2,
    });
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Data", "Profile", "Quality", "Provenance"]);

    const data = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Data"]!, { header: 1 });
    expect(data[0]).toEqual(["id", "city"]);
    expect(data[1]).toEqual([1, "Pune"]);

    const prov = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Provenance"]!, { header: 1 });
    const sampledRow = prov.find((r) => r[0] === "sampled");
    expect(sampledRow?.[1]).toBe("no");
  });

  it("omits Profile/Quality when absent and marks sampled exports honestly", () => {
    const buf = buildWorkbook({
      columns: [{ name: "id", type: "number" }],
      rows: [[1], [2], [3]],
      profile: null,
      warnings: [],
      totalRows: 50_000,
    });
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Data", "Provenance"]);
    const prov = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["Provenance"]!, { header: 1 });
    expect(prov.find((r) => r[0] === "sampled")?.[1]).toContain("yes");
  });

  it("round-trips typed values (numbers stay numbers, nulls stay empty)", () => {
    const buf = buildWorkbook({
      columns: [
        { name: "n", type: "number" },
        { name: "s", type: "string" },
      ],
      rows: [[42, null]],
      profile: null,
      warnings: [],
      totalRows: 1,
    });
    const wb = XLSX.read(buf, { type: "buffer" });
    const data = XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets["Data"]!, { header: 1, defval: null });
    expect(data[1]).toEqual([42, null]);
  });
});
