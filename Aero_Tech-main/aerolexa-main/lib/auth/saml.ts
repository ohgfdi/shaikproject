/**
 * SAML 2.0 Service Provider — pure, testable core.
 *
 * Implements the Web Browser SSO profile with the HTTP-Redirect binding for
 * AuthnRequests and HTTP-POST binding for Responses — the common Okta /
 * Entra ID / OneLogin / Keycloak configuration.
 *
 * Production-grade posture (mirrors the OIDC module's honesty rules):
 *  - Metadata discovery: fetch + validate the IdP's entityID, POST SSO
 *    endpoint and X.509 signing certificate from `<EntityDescriptor>` /
 *    `<IDPSSODescriptor>` (protocolSupportEnumeration must include SAML 2.0).
 *  - Response validation, all mandatory:
 *      • XML-dsig signature over the <Assertion> or the whole <Response>
 *        (xml-crypto verifies real signatures; a signed response covering an
 *        unsigned assertion is accepted, an unsigned anything is not);
 *      • the signing X.509 must be one of the metadata certs (allow-list);
 *      • InResponseTo must match our stored request id (replay/CSRF bound);
 *      • NotBefore / NotOnOrAfter conditions enforced (with 90 s clock skew);
 *      • Audience must equal our entity id;
 *      • SubjectConfirmationData Recipient = ACS + NotOnOrAfter enforced.
 *  - Failure modes are OidcError-style: message names what happened and the
 *    remedy, never a raw XML dump.
 *
 * Identity mapping mirrors the OIDC bridge: the NameID (email format) or an
 * `email` attribute provisions/links the Ledgerly account by verified email.
 */

import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

export class SamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlError";
  }
}

/* ------------------------------------------------------------------ */
/* Metadata discovery                                                  */
/* ------------------------------------------------------------------ */

export interface SamlIdpMetadata {
  entityID: string;
  ssoPostUrl: string;
  /** PEM X.509 certificate(s) the IdP signs responses with. */
  certificates: string[];
  /** Human provider label for the login screen (best-effort). */
  label: string | null;
}

const METADATA_TIMEOUT_MS = 5_000;

/** Decode one X.509 cert body (X509Certificate accepts DER base64 or PEM). */
function toPem(certBody: string): string {
  const cleaned = certBody
    .replace(/\s+/g, "")
    .replace(/^-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----$/, "");
  return `-----BEGIN CERTIFICATE-----\n${(cleaned.match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Parse IdP metadata XML into the fields the SP needs. Throws SamlError with
 * an operator remedy when the document is not a SAML 2.0 IdP descriptor.
 */
export function parseIdpMetadata(xml: string): SamlIdpMetadata {
  const entityMatch = /<(?:[\w.-]+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/.exec(xml);
  if (!entityMatch)
    throw new SamlError("Metadata XML has no EntityDescriptor/entityID — is this an IdP metadata file?");
  const entityID = entityMatch[1]!;

  const idpDescriptor =
    /<(?:[\w.-]+:)?IDPSSODescriptor\b[^>]*protocolSupportEnumeration="([^"]*)"[^>]*>|<(?:[\w.-]+:)?IDPSSODescriptor\b[^>]*>/.exec(
      xml,
    );
  if (!idpDescriptor) {
    throw new SamlError("Metadata has no IDPSSODescriptor — this file does not describe a SAML identity provider.");
  }
  if (idpDescriptor[1] !== undefined && !/urn:oasis:names:tc:SAML:2\.0:protocol/.test(idpDescriptor[1])) {
    throw new SamlError("The IdP descriptor does not declare SAML 2.0 protocol support.");
  }

  const post =
    /<(?:[\w.-]+:)?SingleSignOnService\b[^>]*\bBinding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST"[^>]*\bLocation="([^"]+)"/.exec(
      xml,
    );
  if (!post) {
    throw new SamlError(
      "The metadata has no HTTP-POST SingleSignOnService. How to fix: export the full IdP metadata (the federation metadata file), not a partial snippet.",
    );
  }

  const certificates: string[] = [];
  const certRegex = /<(?:[\w.-]+:)?X509Certificate>([^<]+)<\/(?:[\w.-]+:)?X509Certificate>/g;
  let certMatch: RegExpExecArray | null;
  while ((certMatch = certRegex.exec(xml)) !== null) {
    if (certMatch[1] && certMatch[1].trim()) certificates.push(toPem(certMatch[1]));
  }
  if (certificates.length === 0) {
    throw new SamlError(
      'The metadata contains no X509Certificate. How to fix: the IdP must sign responses — export metadata that includes the signing certificate (KeyDescriptor use="signing").',
    );
  }

  const labelMatch = /<(?:[\w.-]+:)?OrganizationName\b[^>]*>(?:<[^>]*>)?([^<]+)/.exec(xml);
  return {
    entityID,
    ssoPostUrl: post[1]!,
    certificates,
    label: labelMatch?.[1]?.trim() ?? null,
  };
}

/** Fetch + parse the IdP metadata document (SAML_METADATA_URL). */
export async function fetchIdpMetadata(url: string, fetchImpl: typeof fetch = fetch): Promise<SamlIdpMetadata> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      headers: { accept: "application/xml, text/xml, application/samlmetadata+xml, */*" },
    });
  } catch (err) {
    if (err instanceof SamlError) throw err;
    throw new SamlError(
      `Could not fetch the SAML metadata document (${url}). How to fix: verify SAML_METADATA_URL is reachable from this server.`,
    );
  }
  if (!res.ok) {
    throw new SamlError(`The metadata URL answered HTTP ${res.status}. How to fix: check SAML_METADATA_URL.`);
  }
  const text = await res.text();
  return parseIdpMetadata(text);
}

/* ------------------------------------------------------------------ */
/* SP configuration                                                    */
/* ------------------------------------------------------------------ */

export const SAML_ENTITY_ID = "urn:aerolexa:sp";
/** Clock skew allowance for NotBefore / NotOnOrAfter (seconds). */
export const SAML_CLOCK_SKEW_S = 90;

export function samlAcsUrl(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/auth/saml/acs`;
}

/**
 * Build the AuthnRequest XML. Ids are unique per request; IssueInstant is
 * always UTC (ISO-8601 with Z, per SAML schema).
 */
export function buildAuthnRequestXml(opts: { requestId: string; issueInstant: Date; acsUrl: string }): string {
  const instant = opts.issueInstant.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${opts.requestId}" Version="2.0" IssueInstant="${instant}" ` +
    `AssertionConsumerServiceURL="${opts.acsUrl}">` +
    `<saml:Issuer>${SAML_ENTITY_ID}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`
  );
}

/**
 * Serialize the AuthnRequest for the HTTP-Redirect binding:
 * DEFLATE (raw) → base64 → URL-encode, with SigAlg omitted (unsigned request;
 * the IdP's signed Response is the trust anchor).
 */
export function buildRedirectUrl(opts: { ssoUrl: string; xml: string; relayState: string }): string {
  const deflated = deflateRawSync(Buffer.from(opts.xml, "utf8"));
  // Raw base64 — URLSearchParams performs the percent-encoding exactly once.
  const url = new URL(opts.ssoUrl);
  url.searchParams.set("SAMLRequest", deflated.toString("base64"));
  if (opts.relayState) url.searchParams.set("RelayState", opts.relayState);
  return url.toString();
}

/** Fresh request id (SAML ids must be NCName-safe and unique). */
export function createSamlRequestId(): string {
  return `_Ledgerly${randomBytes(12).toString("hex")}`;
}

/** State cookie value: HMAC-able random + our request id. */
export function createStatePayload(requestId: string): string {
  return `${createStateNonce()}.${requestId}`;
}

function createStateNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function splitStatePayload(state: string): { nonce: string; requestId: string } | null {
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  return { nonce: state.slice(0, dot), requestId: state.slice(dot + 1) };
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

export interface SamlValidationContext {
  /** The raw HTTP-POST body field (base64, per binding). */
  samlResponse: string;
  /** XML document string. */
  xml: string;
  /** Allowed IdP signing certificates (PEM) from metadata. */
  certificates: string[];
  /** Our stored request id (InResponseTo must match). */
  requestId: string;
  /** Our entity id (must be the Audience). */
  audience: string;
  /** Our ACS (must be the SubjectConfirmationData Recipient). */
  acsUrl: string;
  now: Date;
}

export interface SamlIdentity {
  nameId: string | null;
  email: string | null;
  name: string | null;
  sessionIndex: string | null;
  attributes: Record<string, string>;
}

interface ParsedNames {
  /** Signature inside the Assertion (preferred). */
  assertionSigned: boolean;
  responseSigned: boolean;
}

/** True when any signature in the document verifies against an allowed cert. */
function verifySignature(
  xml: string,
  certs: string[],
): { ok: boolean; signedAssertion: boolean; signedResponse: boolean } {
  // Locate the assertion's start so we can tell where each signature lives.
  const assertionStart = xml.search(/<[\w:]*Assertion[\s>]/);
  const sigRe = /<[\w:]*Signature\b[\s\S]*?<\/[\w:]*Signature>/g;
  let m: RegExpExecArray | null;
  const sigs: { start: number; body: string }[] = [];
  while ((m = sigRe.exec(xml)) !== null) {
    sigs.push({ start: m.index, body: m[0] });
  }
  const signedAssertion = sigs.some((s) => assertionStart >= 0 && s.start > assertionStart);
  const signedResponse = sigs.length > 0;

  let ok = false;
  for (const sig of sigs) {
    for (const cert of certs) {
      try {
        const verifier = new SignedXml({
          publicCert: cert,
          signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
        });
        verifier.loadSignature(sig.body);
        ok = verifier.checkSignature(xml) || ok;
        if (ok) break;
      } catch {
        // try next cert / next signature
      }
    }
    if (ok) break;
  }
  return { ok, signedAssertion, signedResponse };
}

/** AttributeStatement → flat map (Name → first AttributeValue text). */
export function parseAttributes(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attrRe = /<(?:[\w.-]+:)?Attribute\b[^>]*\bName="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Attribute>/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(xml)) !== null) {
    const name = m[1]!;
    const valueMatch = /<(?:[\w.-]+:)?AttributeValue(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?AttributeValue>/.exec(
      m[2] ?? "",
    );
    if (valueMatch) out[name] = valueMatch[1]!.trim();
  }
  return out;
}

/** Extract the email-format NameID. */
export function parseNameId(xml: string): string | null {
  const re =
    /<(?:[\w.-]+:)?NameID\b[^>]*\bFormat="urn:oasis:names:tc:SAML:1\.1:nameid-format:emailAddress"[^>]*>([^<]+)</i;
  const m = re.exec(xml);
  if (m?.[1]) return m[1].trim();
  const any = /<(?:[\w.-]+:)?NameID(?:\s[^>]*)?>([^<]+)</.exec(xml);
  return any?.[1]?.trim() ?? null;
}

/** Parse and validate a SAML Response; throws SamlError on any failure. */
export function validateSamlResponse(ctx: SamlValidationContext): SamlIdentity {
  let decoded: string;
  try {
    decoded = Buffer.from(ctx.samlResponse, "base64").toString("utf8");
  } catch {
    throw new SamlError("The SAML response is not valid base64.");
  }
  const xml = decoded || ctx.xml;

  if (/<(?:[\w.-]+:)?Response[\s>]/.test(xml) === false) {
    throw new SamlError("The posted form does not contain a SAML Response document.");
  }

  // 1) Status must be Success.
  // StatusCode carries a Value attribute, not text.
  const statusCodeValue = /<(?:[\w.-]+:)?StatusCode\b[^>]*\bValue="([^"]+)"/.exec(xml)?.[1] ?? "";
  if (statusCodeValue && !statusCodeValue.endsWith("status:Success")) {
    throw new SamlError(`The identity provider did not authenticate you (status ${statusCodeValue.split(":").pop()}).`);
  }

  // 2) InResponseTo must match the request we sent (replay/CSRF binding).
  const inResponseTo = /<(?:[\w.-]+:)?Response\b[^>]*\bInResponseTo="([^"]+)"/.exec(xml)?.[1] ?? null;
  if (!inResponseTo) {
    throw new SamlError("The SAML response is missing InResponseTo — IdP-initiated flows are disabled.");
  }
  if (inResponseTo !== ctx.requestId) {
    throw new SamlError("InResponseTo does not match the sign-in request — possible replay. Start again.");
  }

  // 3) Signature: signed assertion OR signed response, verified against the
  //    metadata certificate allow-list. Unsigned anything is rejected.
  const sig = verifySignature(xml, ctx.certificates);
  if (!sig.ok) {
    throw new SamlError(
      "The SAML response signature is invalid or the signing certificate is not the one in the IdP metadata.",
    );
  }
  const signed: ParsedNames = { assertionSigned: sig.signedAssertion, responseSigned: sig.signedResponse };
  if (!signed.assertionSigned && !signed.responseSigned) {
    throw new SamlError("Neither the assertion nor the response is signed.");
  }

  // 4) Conditions window (NotBefore / NotOnOrAfter) with clock skew.
  const notBefore = /<(?:[\w.-]+:)?Conditions\b[^>]*\bNotBefore="([^"]+)"/.exec(xml)?.[1] ?? null;
  const notOnOrAfter = /<(?:[\w.-]+:)?Conditions\b[^>]*\bNotOnOrAfter="([^"]+)"/.exec(xml)?.[1] ?? null;
  const nowMs = ctx.now.getTime();
  if (notBefore && nowMs + SAML_CLOCK_SKEW_S * 1000 < Date.parse(notBefore)) {
    throw new SamlError(
      "The assertion is not valid yet (NotBefore is in the future) — check the server clock or IdP clock skew.",
    );
  }
  if (notOnOrAfter && nowMs - SAML_CLOCK_SKEW_S * 1000 >= Date.parse(notOnOrAfter)) {
    throw new SamlError("The assertion has expired (NotOnOrAfter passed) — start again.");
  }

  // 5) Audience restriction.
  const audiences: string[] = [];
  const audRe = /<(?:[\w.-]+:)?Audience(?:\s[^>]*)?>([^<]+)<\/(?:[\w.-]+:)?Audience>/g;
  let audMatch: RegExpExecArray | null;
  while ((audMatch = audRe.exec(xml)) !== null) {
    audiences.push(audMatch[1]!.trim());
  }
  if (audiences.length > 0 && !audiences.includes(ctx.audience)) {
    throw new SamlError(
      `The assertion audience (${audiences.join(", ")}) does not include this deployment (${ctx.audience}). How to fix: set the SP entity ID ${ctx.audience} in the IdP application.`,
    );
  }

  // 6) SubjectConfirmationData Recipient + NotOnOrAfter.
  const scdBlock = /<(?:[\w.-]+:)?SubjectConfirmationData\b([^>]*)\/?>/.exec(xml)?.[1] ?? "";
  const recipient = /\bRecipient="([^"]+)"/.exec(scdBlock)?.[1] ?? null;
  if (recipient && recipient !== ctx.acsUrl) {
    throw new SamlError("The assertion Recipient does not match this deployment's ACS URL.");
  }
  const scdExpiry = /\bNotOnOrAfter="([^"]+)"/.exec(scdBlock)?.[1] ?? null;
  if (scdExpiry && nowMs - SAML_CLOCK_SKEW_S * 1000 >= Date.parse(scdExpiry)) {
    throw new SamlError("The subject confirmation has expired — start again.");
  }

  // 7) Identity: NameID (email) or attributes.
  const nameId = parseNameId(xml);
  const attributes = parseAttributes(xml);
  const email = pickEmail(nameId, attributes);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new SamlError(
      "No usable email claim in the assertion. How to fix: configure the IdP to release the email address as the NameID (emailAddress format) or an `email` attribute.",
    );
  }
  const name =
    attributes["displayName"] ??
    attributes["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ??
    ([attributes["givenName"], attributes["surname"]].filter(Boolean).join(" ") || null);

  const sessionIndex = /<(?:[\w.-]+:)?AuthnStatement\b[^>]*\bSessionIndex="([^"]+)"/.exec(xml)?.[1] ?? null;

  return { nameId, email, name, sessionIndex, attributes };
}

function pickEmail(nameId: string | null, attributes: Record<string, string>): string | null {
  for (const key of [
    "email",
    "mail",
    "emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  ]) {
    const v = attributes[key] ?? attributes[key.toLowerCase()];
    if (v) return v;
  }
  return nameId && nameId.includes("@") ? nameId : null;
}

/* ------------------------------------------------------------------ */
/* Shared metadata hash (login page renders provider label)            */
/* ------------------------------------------------------------------ */

/** Stable short id for a metadata URL (cache key + debug). */
export function metadataCacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}
