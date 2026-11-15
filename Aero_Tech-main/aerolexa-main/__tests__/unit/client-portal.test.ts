/**
 * Oracle tests for the client portal's security-critical pure functions.
 *
 * These rules are the whole confidentiality boundary: what a link can show, how
 * long it lives, and what a client may upload. They are asserted exactly, not
 * snapshot-tested.
 */

import { ApiError } from "@/lib/auth/guard";
import {
  DEFAULT_PORTAL_DAYS,
  MAX_PORTAL_DAYS,
  MAX_PORTAL_UPLOAD_BYTES,
  hashPortalToken,
  newPortalToken,
  portalDeliverableVisible,
  portalLinkState,
  sanitizeUploadFilename,
  validatePortalUpload,
} from "@/lib/server/client-portal";

function thrown(fn: () => void): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw");
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 1)]);
const CSV = Buffer.from("date,amount\n2026-04-01,1000\n");

describe("portal tokens", () => {
  it("mints a prefixed, unguessable token and stores only a hash", () => {
    const token = newPortalToken();
    expect(token.raw.startsWith("lpl_")).toBe(true);
    expect(token.raw.length).toBeGreaterThan(40);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).not.toContain(token.raw);
    expect(token.prefix).toBe(token.raw.slice(0, 12));
  });

  it("is deterministic for hashing and unique per mint", () => {
    const a = newPortalToken();
    const b = newPortalToken();
    expect(hashPortalToken(a.raw)).toBe(a.hash);
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("reports revoked, expired and active links distinctly", () => {
    const now = new Date("2026-11-08T09:00:00.000Z");
    expect(portalLinkState({ expiresAt: new Date("2026-12-01T00:00:00Z"), revokedAt: null }, now)).toBe("active");
    expect(portalLinkState({ expiresAt: new Date("2026-12-01T00:00:00Z"), revokedAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe("revoked");
    expect(portalLinkState({ expiresAt: new Date("2026-11-07T00:00:00Z"), revokedAt: null }, now)).toBe("expired");
  });

  it("keeps the documented link lifetime", () => {
    expect(DEFAULT_PORTAL_DAYS).toBe(30);
    expect(MAX_PORTAL_DAYS).toBe(90);
  });
});

describe("portal deliverable visibility", () => {
  it("shows only issued client-variant deliverables", () => {
    expect(portalDeliverableVisible({ variant: "CLIENT", status: "ISSUED" })).toBe(true);
  });

  it("hides drafts, signed-but-unissued work and every reviewer copy", () => {
    expect(portalDeliverableVisible({ variant: "CLIENT", status: "DRAFT" })).toBe(false);
    expect(portalDeliverableVisible({ variant: "CLIENT", status: "SIGNED_OFF" })).toBe(false);
    expect(portalDeliverableVisible({ variant: "CLIENT", status: "IN_REVIEW" })).toBe(false);
    expect(portalDeliverableVisible({ variant: "REVIEWER", status: "ISSUED" })).toBe(false);
  });
});

describe("upload filenames", () => {
  it("strips paths and control characters", () => {
    expect(sanitizeUploadFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeUploadFilename("C:\\clients\\bank\u0000statement.pdf")).toBe("bankstatement.pdf");
    expect(sanitizeUploadFilename("   ")).toBe("upload");
    expect(sanitizeUploadFilename("a".repeat(300) + ".pdf")).toHaveLength(180);
  });
});

describe("upload validation", () => {
  const base = { filename: "bank.pdf", mimeType: "application/pdf", sizeBytes: PDF.length, bytes: PDF };

  it("accepts what the portal advertises and normalises the MIME type", () => {
    expect(validatePortalUpload(base)).toEqual({
      filename: "bank.pdf",
      mimeType: "application/pdf",
      extension: "pdf",
    });
    expect(validatePortalUpload({ ...base, filename: "x.png", mimeType: "image/png", bytes: PNG, sizeBytes: PNG.length }).mimeType).toBe("image/png");
    expect(validatePortalUpload({ ...base, filename: "x.jpg", mimeType: "image/jpeg", bytes: JPEG, sizeBytes: JPEG.length }).mimeType).toBe("image/jpeg");
    expect(validatePortalUpload({ ...base, filename: "x.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: ZIP, sizeBytes: ZIP.length }).extension).toBe("xlsx");
    expect(validatePortalUpload({ ...base, filename: "x.csv", mimeType: "text/plain", bytes: CSV, sizeBytes: CSV.length }).mimeType).toBe("text/csv");
  });

  it("rejects an unsupported extension", () => {
    const err = thrown(() => validatePortalUpload({ ...base, filename: "run.exe", mimeType: "application/octet-stream" }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("UNSUPPORTED_FILE");
  });

  it("rejects a declared type that contradicts the extension", () => {
    const err = thrown(() => validatePortalUpload({ ...base, mimeType: "image/png" }));
    expect(err.code).toBe("UNSUPPORTED_FILE");
  });

  it("rejects a file whose bytes do not match the extension", () => {
    const err = thrown(() => validatePortalUpload({ ...base, bytes: Buffer.from("<html>not a pdf</html>"), sizeBytes: 24 }));
    expect(err.code).toBe("FILE_INVALID");
  });

  it("rejects empty and oversized files before storing anything", () => {
    const empty = thrown(() => validatePortalUpload({ ...base, bytes: Buffer.alloc(0), sizeBytes: 0 }));
    expect(empty.code).toBe("EMPTY_FILE");

    const huge = thrown(() =>
      validatePortalUpload({ ...base, bytes: PDF, sizeBytes: MAX_PORTAL_UPLOAD_BYTES + 1 }),
    );
    expect(huge.status).toBe(413);
  });
});
