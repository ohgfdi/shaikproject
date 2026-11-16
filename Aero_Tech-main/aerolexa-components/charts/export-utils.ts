/**
 * Phase 12: Export Utilities
 *
 * Provides PDF and Excel/CSV export capabilities for charts and data.
 * Uses html2pdf.js for PDF generation and built-in Blob APIs for CSV.
 *
 * Usage:
 *   import { exportToPDF, exportToCSV } from "@/charts/export-utils";
 *
 *   // Export chart as PDF
 *   const pdfBlob = await exportToPDF(element, "My Chart Title");
 *
 *   // Export data as CSV
 *   const csvBlob = await exportToCSV(dataArray, ["column1", "column2"]);
 */
import { saveAs } from "file-saver";

// Mock implementations - in production, integrate with actual libraries
// import html2pdf from "html2pdf.js";
// import { v4 as uuidv4 } from "uuid";

/** Export a DOM element as PDF. */
export async function exportToPDF(
  element: HTMLElement,
  title: string = "Export"
): Promise<Blob> {
  // @todo: Integrate html2pdf.js or server-side PDF generation
  // For now, return a placeholder blob and log the intent
  console.log("PDF export requested for:", title, "element:", element);

  // In a full implementation:
  // - Clone the element
  // - Use html2pdf().from(clonedElement).save(title)
  // - Or send to server endpoint for PDF generation

  // Placeholder: Return a simple blob with export metadata
  const metadata = {
    title,
    exportedAt: new Date().toISOString(),
    format: "pdf",
    elementId: element?.id || "unknown",
  };

  return new Blob(
    [JSON.stringify(metadata, null, 2)],
    { type: "application/json" }
  );
}

/** Export data as CSV blob. */
export function exportToCSV(
  data: unknown[],
  columns: string[]
): Promise<Blob> {
  // @todo: Implement proper CSV generation
  // For now, return placeholder

  // If data is empty, return empty CSV
  if (!data || data.length === 0) {
    const emptyCsv = "No data available";
    return Promise.resolve(new Blob([emptyCsv], { type: "text/csv" }));
  }

  // Generate CSV header
  const header = columns.join(",");
  const rows = data.map((item) =>
    columns
      .map((col) => {
        const value = item[col];
        // Basic escaping - in production use proper CSV library
        const stringValue =
          value !== null && value !== undefined
            ? String(value).replace(/"/g, `""`)
            : "";
        return `"${stringValue}"`;
      })
      .join(",")
  );

  const csvContent = [header, ...rows].join("\n");
  return Promise.resolve(new Blob([csvContent], { type: "text/csv" }));
}

/** Trigger a blob download. */
export function downloadBlob(
  blob: Blob,
  filename: string,
  mimeType: string = "application/octet-stream"
) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export chart data to Excel-friendly format. */
export function exportToExcelData(
  data: unknown[],
  columns: string[],
  sheetName: string = "Sheet1"
): string {
  // Returns CSV string that Excel can import directly
  const header = columns.join(",");
  const rows = data.map((item) =>
    columns
      .map((col) => {
        const value = item[col];
        const stringValue =
          value !== null && value !== undefined
            ? String(value).replace(/"/g, `""`)
            : "";
        return `"${stringValue}"`;
      })
      .join(",")
  );

  return [header, ...rows].join("\n");
}