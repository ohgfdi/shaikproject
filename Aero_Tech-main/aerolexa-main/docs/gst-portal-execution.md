# GST & ITD Portal Execution

Status: **implemented, provider-gated, offline-verifiable.** This document is
the capability and coverage report for the portal filing layer. It is written
so a practice can see exactly what will happen when it presses _File_, what is
real, what is simulated, and what remains to be wired to a live portal account.
The operator steps to switch a deployment from `simulation` to `live` are in
[`filing-go-live-runbook.md`](./filing-go-live-runbook.md); earning confidence
against the NIC sandbox first is in
[`gstn-irp-sandbox-onboarding.md`](./gstn-irp-sandbox-onboarding.md).

## How a filing leaves the building

`lib/engine/filing/gateway.ts` selects exactly one `FilingGateway` for the
process from `FILING_GATEWAY`, so a return can never accidentally leave through
a different transport than the one the operator asked for.

| `FILING_GATEWAY`        | Provider                               | Network | What it does                                                                                                                                                                        |
| ----------------------- | -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(unset)_ / `reference` | `ReferenceFilingGateway`               | none    | Deterministic GSTN-shaped IRN (SHA-256 of canonical payload). Every receipt is labelled `provider: "reference"` and carries `portalMessage: "…nothing was transmitted"`.            |
| `simulation`            | `FilingSimulator`                      | none    | Deterministic, envelope-faithful in-memory portal. Idempotent per `once-token`; honours `payload.simulateRejection`. Pinned for demos and CI.                                       |
| `live`                  | `GstnIrpGateway` / `ItdEfilingGateway` | real    | Real IRP / e-filing transport: the GSTN hybrid RSA+AES handshake, bounded retries, HMAC-free once-token idempotency. Built only when the active channel's credentials are complete. |

Channels (`FILING_CHANNEL`): `irp-irn` (e-invoice IRN), `efiling-return`,
`efiling-audit`.

### Fail-closed credential check

`lib/env.ts` runs a zod **cross-field** check at boot: if
`FILING_GATEWAY=live`, the credentials for the active `FILING_CHANNEL` must be
present or the process refuses to start. `resolveFilingGateway()` re-checks and
throws a readable `CredentialMissingError`, and `filingGatewayHealth()` reports
the missing variable names for the UI. A half-configured live deployment can
never reach filing time.

### Live credential variables

| Channel                            | Variables                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `irp-irn`                          | `FILING_GSTIN`, `FILING_IRP_CLIENT_ID`, `FILING_IRP_CLIENT_SECRET`, `FILING_IRP_PORTAL_USER`, `FILING_IRP_PORTAL_PASSWORD`, `FILING_IRP_PUBLIC_KEY`, `FILING_IRP_BASE_URL`, `FILING_IRP_AUTH_PATH`, `FILING_IRP_ENDPOINT_PATH` |
| `efiling-return` / `efiling-audit` | `FILING_EFILING_TOKEN_URL`, `FILING_EFILING_SUBMIT_URL`, `FILING_EFILING_CLIENT_ID`, `FILING_EFILING_CLIENT_SECRET` (+ optional `FILING_EFILING_USERNAME` / `FILING_EFILING_PASSWORD` for a session grant)                     |

Common: `FILING_TIMEOUT_MS`. Optional: `FILING_IRP_APP_KEY`,
`FILING_IRP_GSP_AUTH_TOKEN`, `FILING_IRP_GSP_AUTH_SIGNATURE` (GSP-mediated
access only).

For `efiling-*` the response field paths are configurable too — set
`FILING_EFILING_TOKEN_FIELD`, `FILING_EFILING_ACK_NUMBER_FIELD`,
`FILING_EFILING_ACK_DATE_FIELD`, `FILING_EFILING_STATUS_FIELD`,
`FILING_EFILING_ERROR_CODE_FIELD`, `FILING_EFILING_ERROR_MESSAGE_FIELD`
(comma-separated dotted JSON paths, first present wins) and
`FILING_EFILING_SUBMIT_BODY_KEY` (the key the ITR JSON is wrapped under; blank
posts raw). A pack whose field names differ from the defaults needs **no code
change** — only config.

## The GSTN IRP handshake (`lib/engine/filing/irp.ts` + `crypto.ts`)

The IRP does **not** accept invoice JSON in the clear. `GstnIrpGateway` runs the
published hybrid scheme — confirmed against the NIC e-Invoice API FAQ and the
sandbox sample code — as two calls:

1. **Auth (RSA/ECB/PKCS1Padding).** The gateway mints a random 32-byte `AppKey`,
   base64-encodes `{ UserName, Password, AppKey, ForceRefreshAccessToken }`,
   encrypts _that_ string with the IRP's RSA public key, and POSTs
   `{ "Data": "<base64 ciphertext>" }` to `FILING_IRP_AUTH_PATH`
   (`/eivital/v1.04/auth`). The response carries an `AuthToken` (valid 360
   minutes) and a `Sek` (Session Encryption Key) already AES-encrypted with the
   AppKey; the gateway decrypts the Sek with that AppKey and caches both until
   10 minutes before expiry.
2. **IRN submit (AES-256/ECB/PKCS5).** The invoice JSON is AES-encrypted with
   the Sek and base64-encoded into the same `{ "Data": … }` envelope, then POSTed
   to `FILING_IRP_ENDPOINT_PATH` (`/eicore/v1.03/Invoice`) with `client_id`,
   `client_secret`, `gstin`, `user_name`, `AuthToken` and the `once-token`. The
   IRP encrypts its response the same way, so the gateway decrypts `Data` with
   the Sek to read `Irn` / `AckNo` / `AckDt`.

The crypto primitives live in `lib/engine/filing/crypto.ts` and are pure, so an
operator can reproduce the exact bytes the gateway sent without the portal.

### Payload envelope (`lib/engine/filing/crypto.ts`)

- **AppKey / Sek** — 32 random bytes, base64 (44 chars), AES-256.
- **RSA** — `RSA/ECB/PKCS1Padding` (auth envelope, to the IRP public key).
- **AES** — `AES-256/ECB/PKCS5Padding`, base64 in and out (payload envelope,
  with the Sek).
- **Idempotency** — every submission carries a unique RFC-4122 `once-token`
  (v4); retries reuse the token, so a duplicated delivery cannot create a second
  IRN.
- **Retry classification** — transport faults (5xx, network, timeout) retry up
  to `maxAttempts`; 4xx is a non-retryable `PortalRejectionError`.
- **Response parsing** — a `Status: "0"` envelope or an `ErrorDetails` array is
  surfaced as a `PortalRejectionError` (a GSTN business rejection), never a
  success.

## API surface (`app/api/books/[id]/gst-filing/route.ts`)

| Method + `action`               | Purpose                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET action=gstr3b`             | Build the GSTR-3B summary for a book — invoice-derived outward plus caller-supplied ITC.                                                                                                                                           |
| `POST action=gstr9`             | Build the GSTR-9 annual summary from caller-supplied aggregates. Carried on POST because the payload is a request body.                                                                                                            |
| `GET action=campaigns`          | List filing campaigns.                                                                                                                                                                                                             |
| `GET action=gateway-health`     | Provider, per-channel live capability, and missing credentials.                                                                                                                                                                    |
| `POST action=gateway-preflight` | Run the live credential handshake **only** (auth/token exchange; no IRN created, no return lodged) — the safe way to prove credentials before the first live filing. Reports `ok`, `detail` and whether the endpoint is a sandbox. |

### Credential monitoring

`lib/server/filing-credential-monitor.ts` runs the same preflight from the
scheduler tick (`SCHEDULER_ENABLED`) whenever `FILING_GATEWAY=live`, and raises
an in-app **system** notification to firm admins the moment the handshake fails
— then a one-time "restored" notice when it recovers — with a cooldown
(`FILING_CREDENTIAL_ALERT_COOLDOWN_MINUTES`, default 360) so a flapping portal
cannot spam the inbox. Because the tick is every 60s, **probes** are separately
throttled to `FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES` (default 60) — probing a
portal every minute would be gratuitous and rate-limit bait. It transmits
nothing (preflight is auth-only). The fire → cooldown → recover decision is a
pure, oracle-tested function; disable the job with
`FILING_CREDENTIAL_MONITOR_ENABLED=false`.
| `PATCH action=filing-campaign` | Create a campaign (GSTIN, form, period, due date, signing). |
| `PATCH action=update-campaign` | Update a campaign. |
| `PATCH action=submit-campaign` | Submit through `resolveFilingGateway()` and persist the acknowledgement / IRN. |

All money crossing this API is in **rupees** and is converted to the engines'
integer paise internally (`lib/engine/gst-filing.ts`), matching `/api/ca/compute`
and `/api/gst/itc-recon`. Responses that echo stored figures are in paise and
render through `formatInr`.

Error mapping lives in `lib/engine/filing/errors.ts`
(`CredentialMissingError`, `PortalRejectionError`, `PortalTransportError`) and
is turned into typed HTTP responses by the route's `toErrorResponse`.

## Verification

`__tests__/unit/filing-gateway.test.ts` is the oracle: signing vectors
(SHA-256 `abc`, RFC 4231 HMAC), GSTN checksum, IRN shape, once-token format and
uniqueness, retry/rejection/idempotency through an **injected fetch** (no
network), the full IRP handshake against a locally generated RSA keypair (the
test decrypts the auth envelope, recovers the AppKey, mints the Sek, and
encrypts the IRN response with it), AuthToken caching, the auth-only preflight
probe (asserts no invoice call is made), simulator determinism, and provider
selection with env overrides — including the boot-time fail-closed check and the
boot-time rejection of a malformed IRP public key.

The UI half lives in `components/books/gst-filing-panel.tsx` (a **GST filing**
tab in the Books workspace): GSTR-3B, GSTR-9 and the campaign/submit lifecycle,
with the gateway readiness shown up front. The rupee→paise bridge that feeds the
GSTR-9 engine is pinned by `__tests__/unit/gst-filing-bridge.test.ts`.

## Capability & coverage score

Score = Σ(weight × maturity) over capability areas. Maturity: 1.0 shipped &
oracle-tested, 0.5–<1 partial/needs live account, 0.0 absent.

| #   | Capability                                                            | Weight | Maturity | Notes                                                                                                                                                              |
| --- | --------------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Provider selection & fail-closed gating                               | 10     | 1.0      | `gateway.ts` + zod boot check                                                                                                                                      |
| 2   | Canonicalisation, SHA-256, HMAC-SHA256 signing                        | 10     | 1.0      | Oracle-tested against published vectors                                                                                                                            |
| 3   | Bounded retry + jitter + retry classification                         | 10     | 1.0      | Injected-fetch tests                                                                                                                                               |
| 4   | Idempotency (`once-token`, no duplicate IRN)                          | 10     | 1.0      | Simulator + transport tests                                                                                                                                        |
| 5   | Live IRP IRN transport (RSA auth + AES submit)                        | 15     | 0.7      | Handshake implemented to the published NIC shape and keypair-tested; still needs live IRP credentials to certify                                                   |
| 6   | Live ITD e-filing transport                                           | 10     | 0.6      | Token + bearer submit implemented; response field paths are env-configurable (`FILING_EFILING_*_FIELD`) so a pack mismatch needs no code change; still uncertified |
| 7   | Deterministic reference + simulation providers                        | 10     | 1.0      | Offline, labelled "nothing was transmitted"                                                                                                                        |
| 8   | Response parsing & business-rejection surfacing                       | 10     | 1.0      | Tests cover the `Status:"0"` / `ErrorDetails` shape                                                                                                                |
| 9   | API wiring + readiness report                                         | 10     | 1.0      | GET/PATCH actions + `gateway-health`                                                                                                                               |
| 10  | Documentation & coverage reporting                                    | 5      | 1.0      | This document + the go-live runbook                                                                                                                                |
| 11  | Credential preflight, fail-fast key validation & scheduled monitoring | 5      | 1.0      | `filingGatewayPreflight()` + `filing-credential-monitor.ts`; boot rejects a malformed IRP public key                                                               |

**Weighted coverage = (10+10+10+10+10.5+6+10+10+10+5+5) / 105 = 96.5 / 105 ≈ 91.9 / 100.**

Interpretation: **91.9 %** of the weighted capability is shipped and
oracle-tested. The remaining gap is the two live transports not having completed
a production end-to-end filing. The credential handshake, the public key and the
endpoint reachability can now be verified _without_ filing anything
(`action=gateway-preflight`, plus boot-time key validation), so the only unproven
step is the first successful live submission — which needs an actual portal
account and stays honestly reported by `action=gateway-health` rather than hidden.

## Limits (honesty)

- The reference and simulation providers **do not transmit anything**.
- The live transports implement the published IRP (GSTN) and ITD e-filing
  shapes but are **not certified end-to-end** against production accounts;
  treat the first live filing per channel as a controlled pilot.
- The ITD ERI specification is gated behind the e-filing portal. The
  `ItdEfilingGateway` implements the documented session-token + bearer shape,
  and both the endpoints and the response/request field paths are
  env-configurable (`FILING_EFILING_*`), so a registration pack that differs
  from the defaults needs only config — not a code change. The exact paths and
  field names still must be confirmed against the pack before go-live.
- Portal version prefixes (`/eivital/v1.04/auth`, `/eicore/v1.03/Invoice`),
  the RSA public key and any GSP signature headers are versioned by the portals;
  re-verify against the current IRP/ITD specification before go-live.
