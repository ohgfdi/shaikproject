/**
 * PDF Export via Playwright Chromium
 *
 * Renders HTML report documents to professional PDF using a headless browser.
 * This ensures pixel-perfect output matching the HTML export exactly.
 */
import { chromium } from "playwright";

let browserInstance: Awaited<ReturnType<typeof chromium.launch>> | null = null;

/** Get or create a shared browser instance (reused across exports). */
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    });

    // Handle browser disconnect
    browserInstance.on("disconnected", () => {
      browserInstance = null;
    });
  }
  return browserInstance;
}

/** Whether a shared browser process is currently alive (for shutdown hooks). */
export function isBrowserRunning(): boolean {
  return browserInstance !== null;
}

/** Close the shared browser instance (for graceful shutdown). */
export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/** Check if browser is healthy (connected and responsive). */
export async function isBrowserHealthy(): Promise<boolean> {
  if (!browserInstance) return false;
  try {
    // Try to create and close a page to verify browser is responsive
    const page = await browserInstance.newPage();
    await page.close();
    return true;
  } catch {
    browserInstance = null;
    return false;
  }
}

/** Get browser info for monitoring. */
export async function getBrowserInfo(): Promise<{ connected: boolean; pages: number } | null> {
  if (!browserInstance) return { connected: false, pages: 0 };
  try {
    return { connected: browserInstance.isConnected(), pages: browserInstance.contexts().length };
  } catch {
    return { connected: false, pages: 0 };
  }
}

interface PDFExportOptions {
  /** HTML content to render */
  html: string;
  /** Output filename (without extension) */
  filename?: string;
  /** Paper format: "A4" | "Letter" | { width: string; height: string } */
  format?: "A4" | "Letter" | { width: string; height: string };
  /** Margins in mm */
  margin?: { top: string; right: string; bottom: string; left: string };
  /** Print background colors/images */
  printBackground?: boolean;
  /** Scale factor */
  scale?: number;
  /** Wait until network is idle before printing */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Timeout in ms */
  timeout?: number;
}

/** Render HTML to PDF bytes using Playwright Chromium. */
export async function renderHtmlToPdf(options: PDFExportOptions): Promise<Buffer> {
  const {
    html,
    filename: _filename = "report",
    format = "A4",
    margin = { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
    printBackground = true,
    scale = 1.0,
    waitUntil = "networkidle",
    timeout = 60_000,
  } = options;

  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1600 },
    deviceScaleFactor: 1,
  });

  try {
    // Set content and wait for it to be ready
    await page.setContent(html, {
      waitUntil,
      timeout,
    });

    // Wait for fonts to load (important for consistent rendering)
    await page.evaluateHandle("document.fonts.ready");

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: typeof format === "string" ? format : undefined,
      width: typeof format === "object" ? format.width : undefined,
      height: typeof format === "object" ? format.height : undefined,
      margin,
      printBackground,
      scale,
      preferCSSPageSize: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close();
  }
}

/** Render a report HTML document to PDF with Ledgerly-specific defaults. */
export async function renderReportToPdf(html: string, filename?: string): Promise<Buffer> {
  return renderHtmlToPdf({
    html,
    filename: filename ?? `report-${Date.now()}`,
    format: "A4",
    margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
    printBackground: true,
    scale: 1.0,
    waitUntil: "networkidle",
    timeout: 60_000,
  });
}

/** Render a presentation HTML document to PDF. */
export async function renderPresentationToPdf(html: string, filename?: string): Promise<Buffer> {
  return renderHtmlToPdf({
    html,
    filename: filename ?? `presentation-${Date.now()}`,
    format: "A4",
    margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    printBackground: true,
    scale: 1.0,
    waitUntil: "networkidle",
    timeout: 60_000,
  });
}

/** Render a notebook HTML document to PDF. */
export async function renderNotebookToPdf(html: string, filename?: string): Promise<Buffer> {
  return renderHtmlToPdf({
    html,
    filename: filename ?? `notebook-${Date.now()}`,
    format: "A4",
    margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" },
    printBackground: true,
    scale: 1.0,
    waitUntil: "networkidle",
    timeout: 60_000,
  });
}
