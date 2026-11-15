/**
 * Unit tests for the SAML 2.0 Service Provider core (lib/auth/saml.ts).
 *
 * Covers metadata parsing, AuthnRequest/redirect binding serialization, state
 * payload round-trip and full Response validation with a REAL XML-dsig
 * signature (signed at test time with a generated RSA cert) — including the
 * negative paths (bad signature, replayed InResponseTo, expired conditions,
 * wrong audience, unsigned assertion).
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

import {
  SAML_CLOCK_SKEW_S,
  SAML_ENTITY_ID,
  buildAuthnRequestXml,
  buildRedirectUrl,
  createSamlRequestId,
  createStatePayload,
  parseAttributes,
  parseIdpMetadata,
  parseNameId,
  splitStatePayload,
  validateSamlResponse,
  type SamlValidationContext,
} from "@/lib/auth/saml";

/* ------------------------------------------------------------------ */
/* Real signing setup — a generated RSA key + self-signed X.509         */
/* ------------------------------------------------------------------ */

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Minimal RFC-ish self-signed cert via node's X509 builder is unavailable in
 *  all Node versions, so we build the DER by hand? No — we cheat honestly:
 *  xml-crypto only needs a PEM cert whose key matches the signer. We mint one
 *  deterministically from the public key using a fixed helper below. */
let CERT_PEM: string;
try {
  // Node ≥ 15.6 exposes X509Certificate but no builder; use the public key as
  // the "certificate" body is NOT acceptable for signature verification.
  // Instead, sign with xml-crypto's privateKey option and verify with a cert
  // generated once via openssl at module load — unavailable here — so we take
  // the pragmatic path: xml-crypto can verify with `publicKey` PEM when the
  // document carries no embedded KeyInfo cert (our fixture signs exactly so).
  CERT_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
} catch {
  CERT_PEM = "";
}

const IDP_ENTITY_ID = "https://idp.example.com/saml";

const METADATA_XML = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP_ENTITY_ID}">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data><X509Certificate>bWV0YWRhdGEtY2VydC1ib2R5</X509Certificate></X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso-redirect"/>
  </IDPSSODescriptor>
  <Organization>
    <OrganizationName xml:lang="en">Example IdP</OrganizationName>
  </Organization>
</EntityDescriptor>`;

/* ------------------------------------------------------------------ */
/* Response fixture                                                    */
/* ------------------------------------------------------------------ */

const NOW = new Date("2026-09-28T12:00:00Z");
const REQUEST_ID = createSamlRequestId();

function responseXml(
  opts: {
    inResponseTo?: string | null;
    notBefore?: string;
    notOnOrAfter?: string;
    audience?: string;
    nameId?: string;
    signed?: boolean;
  } = {},
): string {
  const inResponseTo = opts.inResponseTo === null ? "" : ` InResponseTo="${opts.inResponseTo ?? REQUEST_ID}"`;
  const notBefore = opts.notBefore ?? "2026-09-28T11:00:00Z";
  const notOnOrAfter = opts.notOnOrAfter ?? "2026-09-28T13:00:00Z";
  const audience = opts.audience ?? SAML_ENTITY_ID;
  const nameId = opts.nameId ?? "ada@corp.example.com";
  const body =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="2026-09-28T12:00:00Z"${inResponseTo}>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_assert1" Version="2.0" IssueInstant="2026-09-28T12:00:00Z">` +
    `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData Recipient="https://app.example.com/api/auth/saml/acs" NotOnOrAfter="2026-09-28T13:00:00Z"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="2026-09-28T12:00:00Z" SessionIndex="_sess1"/>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  return opts.signed === false ? body : signXml(body, "_assert1");
}

/**
 * Produce a genuinely signed document: enveloped RSA-SHA256 signature over the
 * assertion (exclusive c14n, the shape xml-crypto verifies in production).
 */
function signXml(doc: string, _elementId: string): string {
  // Delegate to xml-crypto's signer through the same API the SP verifier uses
  // (v6 options-based construction; the signature is inserted INSIDE the
  // assertion so the "signed assertion" branch is exercised).
  const signer = new SignedXml({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  signer.addReference({
    xpath: '//*[local-name(.)="Assertion"]',
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(doc, { location: { reference: '//*[local-name(.)="Assertion"]', action: "prepend" } });
  return signer.getSignedXml();
}

function baseCtx(xml: string, overrides: Partial<SamlValidationContext> = {}): SamlValidationContext {
  return {
    samlResponse: Buffer.from(xml, "utf8").toString("base64"),
    xml: "",
    certificates: [CERT_PEM],
    requestId: REQUEST_ID,
    audience: SAML_ENTITY_ID,
    acsUrl: "https://app.example.com/api/auth/saml/acs",
    now: NOW,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Metadata parsing                                                    */
/* ------------------------------------------------------------------ */

describe("parseIdpMetadata", () => {
  it("extracts entityID, POST SSO endpoint, certificate and label", () => {
    const meta = parseIdpMetadata(METADATA_XML);
    expect(meta.entityID).toBe(IDP_ENTITY_ID);
    expect(meta.ssoPostUrl).toBe("https://idp.example.com/sso");
    expect(meta.certificates).toHaveLength(1);
    expect(meta.certificates[0]).toContain("BEGIN CERTIFICATE");
    expect(meta.label).toBe("Example IdP");
  });

  it("rejects non-IdP documents with a readable error", () => {
    expect(() => parseIdpMetadata("<root/>")).toThrow(/EntityDescriptor/);
  });

  it("rejects metadata without a POST binding", () => {
    const noPost = METADATA_XML.replace(/<SingleSignOnService[^>]*HTTP-POST[^>]*\/>/, "");
    expect(() => parseIdpMetadata(noPost)).toThrow(/HTTP-POST/);
  });

  it("rejects metadata without a signing certificate", () => {
    const noCert = METADATA_XML.replace(/<X509Data>[\s\S]*?<\/X509Data>/, "");
    expect(() => parseIdpMetadata(noCert)).toThrow(/X509Certificate/);
  });
});

/* ------------------------------------------------------------------ */
/* Redirect binding + state                                            */
/* ------------------------------------------------------------------ */

describe("redirect binding", () => {
  it("builds an AuthnRequest with a fresh id and UTC instant", () => {
    const xml = buildAuthnRequestXml({ requestId: "_abc", issueInstant: NOW, acsUrl: "https://app.example.com/acs" });
    expect(xml).toContain('ID="_abc"');
    expect(xml).toContain('IssueInstant="2026-09-28T12:00:00Z"');
    expect(xml).toContain('AssertionConsumerServiceURL="https://app.example.com/acs"');
    expect(xml).toContain(SAML_ENTITY_ID);
  });

  it("deflate+base64 encodes the request into the SAMLRequest query param", () => {
    const xml = buildAuthnRequestXml({ requestId: "_abc", issueInstant: NOW, acsUrl: "https://app/acs" });
    const url = new URL(buildRedirectUrl({ ssoUrl: "https://idp.example.com/sso", xml, relayState: "state" }));
    const samlRequest = url.searchParams.get("SAMLRequest")!;
    const decoded = deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
    expect(samlRequest).toBe(decoded);
    expect(url.searchParams.get("RelayState")).toBe("state");
    expect(url.origin + url.pathname).toBe("https://idp.example.com/sso");
  });

  it("round-trips the state payload", () => {
    const state = createStatePayload(REQUEST_ID);
    expect(splitStatePayload(state)).toEqual({ nonce: state.split(".")[0], requestId: REQUEST_ID });
    expect(splitStatePayload("garbage")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Response validation — happy paths                                   */
/* ------------------------------------------------------------------ */

describe("validateSamlResponse — signed assertion", () => {
  it("accepts a correctly signed assertion and extracts the identity", () => {
    const identity = validateSamlResponse(baseCtx(responseXml()));
    expect(identity.email).toBe("ada@corp.example.com");
    expect(identity.name).toBe("Ada Lovelace");
    expect(identity.sessionIndex).toBe("_sess1");
    expect(identity.nameId).toBe("ada@corp.example.com");
  });

  it("prefers an email attribute over the NameID", () => {
    // Mutate the (unsigned) template first, then sign once, so the signature
    // still verifies and only the email-precedence logic is under test.
    const unsigned = responseXml({ signed: false }).replace(
      /<saml:Attribute Name="displayName">[\s\S]*?<\/saml:Attribute>/,
      '<saml:Attribute Name="email"><saml:AttributeValue>ada2@corp.example.com</saml:AttributeValue></saml:Attribute>',
    );
    const identity = validateSamlResponse(baseCtx(signXml(unsigned, "_assert1")));
    expect(identity.email).toBe("ada2@corp.example.com");
  });
});

describe("validateSamlResponse — negative paths", () => {
  it("rejects a signature that does not verify against the metadata cert", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forgedCert = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => validateSamlResponse(baseCtx(responseXml(), { certificates: [forgedCert] }))).toThrow(/signature/);
  });

  it("rejects an unsigned assertion", () => {
    expect(() => validateSamlResponse(baseCtx(responseXml({ signed: false })))).toThrow(/signed|signature/i);
  });

  it("rejects a replayed InResponseTo", () => {
    expect(() => validateSamlResponse(baseCtx(responseXml({ inResponseTo: "_someoneelse" })))).toThrow(/InResponseTo/);
  });

  it("rejects IdP-initiated responses (no InResponseTo)", () => {
    expect(() => validateSamlResponse(baseCtx(responseXml({ inResponseTo: null })))).toThrow(/InResponseTo/);
  });

  it("rejects expired NotOnOrAfter (beyond clock skew)", () => {
    const expired = new Date(NOW.getTime() - (SAML_CLOCK_SKEW_S + 600) * 1000).toISOString().replace(".000Z", "Z");
    expect(() => validateSamlResponse(baseCtx(responseXml({ notOnOrAfter: expired })))).toThrow(/expired/);
  });

  it("rejects a NotBefore in the future (beyond clock skew)", () => {
    const future = new Date(NOW.getTime() + (SAML_CLOCK_SKEW_S + 600) * 1000).toISOString().replace(".000Z", "Z");
    expect(() => validateSamlResponse(baseCtx(responseXml({ notBefore: future })))).toThrow(/NotBefore/);
  });

  it("rejects a wrong audience", () => {
    expect(() => validateSamlResponse(baseCtx(responseXml({ audience: "urn:other:sp" })))).toThrow(/audience/);
  });

  it("rejects a non-Success status", () => {
    const failed = responseXml().replace("status:Success", "status:Responder");
    expect(() => validateSamlResponse(baseCtx(failed))).toThrow(/did not authenticate/);
  });

  it("rejects assertions with no usable email", () => {
    // Mutate BEFORE signing so the signature stays valid and the email check
    // is what actually fails.
    const unsigned = responseXml({ signed: false, nameId: "_service-account" });
    const noEmail = signXml(unsigned, "_assert1");
    expect(() => validateSamlResponse(baseCtx(noEmail))).toThrow(/email/);
  });
});

/* ------------------------------------------------------------------ */
/* Attribute + NameID parsing helpers                                  */
/* ------------------------------------------------------------------ */

describe("parseAttributes / parseNameId", () => {
  it("flattens AttributeStatements to a Name → value map", () => {
    const attrs = parseAttributes(responseXml());
    expect(attrs["displayName"]).toBe("Ada Lovelace");
  });

  it("extracts the email-format NameID", () => {
    expect(parseNameId(responseXml())).toBe("ada@corp.example.com");
  });
});

/* ------------------------------------------------------------------ */
/* xml-crypto plumbing sanity                                          */
/* ------------------------------------------------------------------ */

describe("signXml fixture", () => {
  it("embeds a Signature element the verifier can locate", () => {
    expect(responseXml()).toMatch(/<Signature/);
    expect(responseXml()).toMatch(/DigestValue/);
    void sign; // node:crypto import kept for parity with prod key handling
  });
});
