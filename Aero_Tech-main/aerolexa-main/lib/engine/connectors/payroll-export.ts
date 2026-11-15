/**
 * Payroll Export Connector — parses payroll data from CSV/Excel/JSON exports.
 */

import { parse } from "csv-parse/sync";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as XLSX from "xlsx";

import type { ColType, SqlValue } from "@/lib/types";

import type { PayrollExportConfig } from "./config";
import { ConnectorError } from "./errors";

export interface PayrollRecord {
  employee_id: string;
  employee_name: string;
  basic: number;
  da?: number;
  hra?: number;
  gross_salary: number;
  pf_employee?: number;
  esi_employee?: number;
  professional_tax?: number;
  net_pay: number;
  month: string;
}

export async function parsePayrollExport(filePath: string, config: PayrollExportConfig): Promise<PayrollRecord[]> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv") {
    return parsePayrollCsv(filePath, config);
  } else if (ext === ".xlsx" || ext === ".xls") {
    return parsePayrollExcel(filePath, config);
  } else if (ext === ".json") {
    return parsePayrollJson(filePath);
  } else {
    throw new ConnectorError(`Unsupported payroll format: ${ext}. Supported: CSV, Excel, JSON`, {
      status: 400,
      code: "PAYROLL_UNSUPPORTED_FORMAT",
    });
  }
}

async function parsePayrollCsv(filePath: string, config: PayrollExportConfig): Promise<PayrollRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    from_line: config.skipRows + 1,
  }) as Record<string, string>[];

  return normalizePayrollRecords(records, config);
}

function parsePayrollExcel(filePath: string, config: PayrollExportConfig): PayrollRecord[] {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ConnectorError("Excel file has no sheets");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new ConnectorError("Excel sheet not found");
  const records = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const sliced = records.slice(config.skipRows) as Record<string, string>[];
  return normalizePayrollRecords(sliced, config);
}

async function parsePayrollJson(filePath: string): Promise<PayrollRecord[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(content);
  if (Array.isArray(data)) {
    return normalizePayrollRecords(data as Record<string, string>[]);
  }
  return [];
}

function normalizePayrollRecords(records: Record<string, string>[], config?: PayrollExportConfig): PayrollRecord[] {
  const results: PayrollRecord[] = [];
  for (const row of records) {
    const employee_id =
      row.employee_id || row.EmployeeID || row["Employee Id"] || row.emp_id || row.EmpCode || row.code || "";
    const employee_name = row.employee_name || row.EmployeeName || row["Employee Name"] || row.name || row.Name || "";
    const basic = parseFloat((row.basic || row.Basic || row["Basic Pay"] || "0").replace(/,/g, "")) || 0;
    const gross_salary =
      parseFloat(
        (row.gross_salary || row.GrossSalary || row.Gross || row["Gross Salary"] || row.total_gross || "0").replace(
          /,/g,
          "",
        ),
      ) || 0;
    const net_pay =
      parseFloat((row.net_pay || row.NetPay || row.Net || row["Net Pay"] || row.take_home || "0").replace(/,/g, "")) ||
      0;
    const month = config?.month || row.month || row.Month || row.payroll_month || row.period || "";

    if (!employee_id && !employee_name) continue;

    results.push({
      employee_id,
      employee_name,
      basic,
      da: parseFloat((row.da || row.DA || row.DearnessAllowance || "0").replace(/,/g, "")) || undefined,
      hra: parseFloat((row.hra || row.HRA || row["House Rent Allowance"] || "0").replace(/,/g, "")) || undefined,
      gross_salary,
      pf_employee:
        parseFloat((row.pf_employee || row.PFEmployee || row["PF Employee"] || "0").replace(/,/g, "")) || undefined,
      esi_employee:
        parseFloat((row.esi_employee || row.ESIEmployee || row["ESI Employee"] || "0").replace(/,/g, "")) || undefined,
      professional_tax:
        parseFloat((row.professional_tax || row.PT || row.ProfessionalTax || "0").replace(/,/g, "")) || undefined,
      net_pay,
      month,
    });
  }
  return results;
}

export function payrollToRows(records: PayrollRecord[]): {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
} {
  const columns = [
    { name: "employee_id", type: "string" as ColType },
    { name: "employee_name", type: "string" as ColType },
    { name: "basic", type: "number" as ColType },
    { name: "da", type: "number" as ColType },
    { name: "hra", type: "number" as ColType },
    { name: "gross_salary", type: "number" as ColType },
    { name: "pf_employee", type: "number" as ColType },
    { name: "esi_employee", type: "number" as ColType },
    { name: "professional_tax", type: "number" as ColType },
    { name: "net_pay", type: "number" as ColType },
    { name: "month", type: "string" as ColType },
  ];
  const rows = records.map((r) => [
    r.employee_id,
    r.employee_name,
    r.basic,
    r.da || null,
    r.hra || null,
    r.gross_salary,
    r.pf_employee || null,
    r.esi_employee || null,
    r.professional_tax || null,
    r.net_pay,
    r.month,
  ]);
  return { columns, rows };
}
