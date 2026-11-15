/**
 * Approval audit bundle as a printable PDF.
 *
 * A firm forwards a PDF, not a JSON blob. This writes a small, valid PDF with
 * the built-in Helvetica fonts — no runtime dependency, no browser, no external
 * renderer. The content is the same evidence as the JSON bundle: filing,
 * receipt digest, verification checks, signature verdict, event trail and the
 * honesty notes.
 *
 * The writer is deliberately narrow: ASCII text, A4, fixed margins, no images
 * or links. That keeps it auditable and testable. If richer output is needed
 * later, replace this module, not the bundle builder.
 */

import type { ApprovalAuditBundle } from "./receipt-audit-bundle";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;
const BOTTOM = 56;
const TOP = 792;
const MAX_CHARS = 98;

type Font = "F1" | "F2";

interface Line {
  text: string;
  font: Font;
  size: number;
}

function ascii(value: string): string {
  return value
    .replace(/₹/g, "INR ")
    .replace(/[—–]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/·/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(value: string, maxChars = MAX_CHARS): string[] {
  const words = ascii(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 19) + " UTC" : iso;
}

function buildLines(bundle: ApprovalAuditBundle): Line[] {
  const lines: Line[] = [];
  const add = (text: string, size = 10, font: Font = "F1") => {
    for (const part of wrap(text, Math.max(40, Math.floor((PAGE_WIDTH - MARGIN * 2) / (size * 0.5))))) {
      lines.push({ text: part, font, size });
    }
  };
  const gap = () => lines.push({ text: " ", font: "F1", size: 10 });

  add("APPROVAL AUDIT BUNDLE", 18, "F2");
  add(`Generated ${formatWhen(bundle.generatedAt)} · ${bundle.format} v${bundle.version}`, 9);
  gap();
  add(`Organization: ${bundle.organization?.name ?? "-"}`, 11, "F2");
  add(`Client: ${bundle.filing.engagementName}`, 11);
  add(`Filing: ${bundle.filing.title} · ${bundle.filing.authority}`);
  add(`Task: ${bundle.filing.taskId} · Due ${bundle.filing.dueDate} · Stage ${bundle.filing.stage}`);
  add(`Filed: ${formatWhen(bundle.filing.filedAt)} · Acknowledgement: ${bundle.filing.acknowledgementReference ?? "-"}`);
  add(`Verification: ${bundle.filing.verificationStatus}`);
  gap();
  add("APPROVAL", 13, "F2");
  add(`Receipt digest: ${bundle.approval.digest ?? "-"}`);
  add(`Digest recomputes: ${bundle.approval.digestMatches === null ? "not available" : bundle.approval.digestMatches ? "yes" : "NO"}`);
  add(
    `Detached signature: ${
      bundle.approval.signatureVerified === null
        ? "not verified (unsigned receipt or no certificate configured)"
        : bundle.approval.signatureVerified
          ? "verified against the configured certificate"
          : "DOES NOT MATCH the configured certificate"
    }`,
  );
  if (bundle.approval.receipt) {
    const receipt = bundle.approval.receipt as { version?: unknown; approval?: { approvedAt?: unknown; approvedBy?: unknown; identity?: unknown; note?: unknown } };
    add(`Receipt version: ${String(receipt.version ?? "-")}`, 10);
    add(`Approved at: ${formatWhen(typeof receipt.approval?.approvedAt === "string" ? receipt.approval.approvedAt : null)}`);
    add(`Approved by: ${typeof receipt.approval?.approvedBy === "string" ? receipt.approval.approvedBy : "-"}`);
    add(`Identity: ${typeof receipt.approval?.identity === "string" ? receipt.approval.identity : "-"}`);
    if (typeof receipt.approval?.note === "string" && receipt.approval.note) add(`Note: ${receipt.approval.note}`);
  } else {
    add("No client approval receipt is stored for this run.", 10, "F2");
  }
  gap();
  add("CHECKS", 13, "F2");
  for (const check of bundle.approval.checks) {
    add(`${check.ok ? "[PASS]" : "[FAIL]"} ${check.label}: ${check.detail}`, 9);
  }
  gap();
  add("EVENT TRAIL", 13, "F2");
  if (bundle.events.length === 0) add("No events recorded.");
  for (const event of bundle.events.slice(0, 40)) {
    add(`${formatWhen(event.createdAt)} · ${event.fromStage ?? "-"} -> ${event.toStage} · ${event.actorId ?? "-"}`, 9);
    if (event.note) add(`  ${event.note}`, 9);
  }
  gap();
  add("NOTES", 13, "F2");
  for (const note of bundle.notes) add(`- ${note}`, 9);
  gap();
  add(
    "This bundle records evidence stored by Ledgerly and recomputed at export time. It is not a legal opinion, and it does not by itself prove that a portal accepted a filing.",
    8,
  );
  return lines;
}

function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [];
  let page: Line[] = [];
  let y = TOP;
  for (const line of lines) {
    const height = line.size + 5;
    if (y - height < BOTTOM) {
      pages.push(page);
      page = [];
      y = TOP;
    }
    page.push(line);
    y -= height;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[{ text: " ", font: "F1", size: 10 }]];
}

function contentFor(lines: Line[]): string {
  let y = TOP;
  const commands = lines.map((line) => {
    y -= line.size + 5;
    return `BT /${line.font} ${line.size} Tf ${MARGIN} ${y} Td (${escapePdf(line.text)}) Tj ET`;
  });
  return commands.join("\n");
}

/** Render the bundle as a valid PDF byte sequence. */
export function renderApprovalReceiptPdf(bundle: ApprovalAuditBundle): Buffer {
  const pages = paginate(buildLines(bundle));
  const font1 = 3;
  const font2 = 4;
  const firstPage = 5;
  const pageIds = pages.map((_, index) => firstPage + index * 2);
  const objects: string[] = [];

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[font1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[font2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  pages.forEach((lines, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const content = contentFor(lines);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  });

  const chunks: Buffer[] = [];
  let offset = 0;
  const append = (value: string) => {
    const buffer = Buffer.from(value, "latin1");
    chunks.push(buffer);
    offset += buffer.length;
  };

  append("%PDF-1.4\n");
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    const body = objects[id];
    if (!body) continue;
    offsets[id] = offset;
    append(`${id} 0 obj\n${body}\nendobj\n`);
  }

  const xrefOffset = offset;
  const size = objects.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  append(xref);
  append(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
