/**
 * Shadow filing plan.
 *
 * Live filing is blocked on external credentials, but a firm can still see
 * exactly what the app WOULD send and what would stop it. This module builds
 * that plan offline: canonical payload digest, idempotency token, credential
 * completeness and signing requirement. It performs no network call and says so
 * — a shadow plan is not portal validation and not a filing.
 */

import { canonicalJson, sha256Hex } from "./signing";
import type { FilingChannel, ProviderKind } from "./types";

export interface FilingShadowInput {
  channel: FilingChannel;
  provider: ProviderKind;
  payload: unknown;
  token: string;
  providerConfigured: boolean;
  missingCredentials: readonly string[];
  signingRequired: boolean;
  signingConfigured: boolean;
}

export interface ShadowCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface FilingShadowPlan {
  mode: "shadow";
  willTransmit: false;
  provider: ProviderKind;
  channel: FilingChannel;
  token: string;
  payloadDigest: string | null;
  checks: ShadowCheck[];
  blockers: string[];
  summary: string;
}

export function buildFilingShadowPlan(input: FilingShadowInput): FilingShadowPlan {
  const checks: ShadowCheck[] = [];
  let payloadDigest: string | null = null;

  try {
    const serialized = canonicalJson(input.payload);
    payloadDigest = sha256Hex(serialized);
    checks.push({
      id: "payload",
      label: "Payload is canonicalisable",
      ok: serialized.length > 2,
      detail:
        serialized.length > 2
          ? `Digest ${payloadDigest.slice(0, 16)}… over ${serialized.length} canonical bytes.`
          : "The payload is empty — there is nothing to file.",
    });
  } catch (err) {
    checks.push({
      id: "payload",
      label: "Payload is canonicalisable",
      ok: false,
      detail: `The payload cannot be canonicalised: ${err instanceof Error ? err.message : "unknown error"}.`,
    });
  }

  checks.push({
    id: "token",
    label: "Idempotency token present",
    ok: input.token.trim().length >= 8,
    detail:
      input.token.trim().length >= 8
        ? "A retry with the same token is deduplicated by the portal."
        : "The token is missing or too short; a retry could file twice.",
  });

  checks.push({
    id: "credentials",
    label: "Channel credentials complete",
    ok: input.providerConfigured,
    detail: input.providerConfigured
      ? `The ${input.channel} channel has every required credential.`
      : `Missing: ${input.missingCredentials.join(", ") || "unknown"}.`,
  });

  checks.push({
    id: "signing",
    label: "DSC signing ready when required",
    ok: !input.signingRequired || input.signingConfigured,
    detail: input.signingRequired
      ? input.signingConfigured
        ? "This channel requires a detached DSC signature and the signing service is configured."
        : "This channel requires a detached DSC signature but no signing service is configured."
      : "This channel does not require a detached DSC signature.",
  });

  const blockers = checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail}`);
  const summary =
    blockers.length === 0
      ? `Shadow plan is complete for ${input.channel}; nothing was transmitted. A live submission would use token ${input.token}.`
      : `Shadow plan has ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}; fix them before a live submission. Nothing was transmitted.`;

  return {
    mode: "shadow",
    willTransmit: false,
    provider: input.provider,
    channel: input.channel,
    token: input.token,
    payloadDigest,
    checks,
    blockers,
    summary,
  };
}
