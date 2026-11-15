# Filing go-live runbook (simulation → live)

This is the operator procedure for moving a deployment from the offline
`simulation` filing provider to the real `live` GSTN IRP / income-tax e-filing
transports. It assumes the code in `lib/engine/filing/` and the capability notes
in [`gst-portal-execution.md`](./gst-portal-execution.md).

> **Fail-closed by design.** `FILING_GATEWAY=live` is validated at boot: if any
> credential for the active `FILING_CHANNEL` is missing, the process **refuses
> to start**. A half-configured install can never reach filing time. Keep that
> behaviour — do not "temporarily" bypass it.

## 0. Before you touch env: collect the credentials

Nothing below can be done by the app for you — these are issued by the portals.

### GSTN IRP (`FILING_CHANNEL=irp-irn`)

| Value                                                   | Where it comes from                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FILING_IRP_CLIENT_ID` / `FILING_IRP_CLIENT_SECRET`     | The API app created on the IRP (taxpayer API) or by your GSP.                                                                              |
| `FILING_IRP_PORTAL_USER` / `FILING_IRP_PORTAL_PASSWORD` | The IRP portal login for the GSTIN being filed (the auth handshake grant).                                                                 |
| `FILING_IRP_PUBLIC_KEY`                                 | The IRP's RSA **public** key (PEM). Mailed on direct taxpayer-API approval, or supplied by your GSP. The auth envelope is encrypted to it. |
| `FILING_IRP_BASE_URL`                                   | The IRP partition for the taxpayer: `https://einvoice1.gst.gov.in` … `einvoice6.gst.gov.in`. Sandbox: `https://einv-apisandbox.nic.in`.    |
| `FILING_GSTIN`                                          | The taxpayer GSTIN being filed.                                                                                                            |

Optional (only for GSP-mediated access, not a direct taxpayer API):
`FILING_IRP_GSP_AUTH_TOKEN`, `FILING_IRP_GSP_AUTH_SIGNATURE`.

`FILING_IRP_AUTH_PATH` (default `/eivital/v1.04/auth`) and
`FILING_IRP_ENDPOINT_PATH` (default `/eicore/v1.03/Invoice`) are the
version-prefixed IRP paths. Confirm the current prefix for your onboarding and
override if it differs.

### Income-tax e-filing (`FILING_CHANNEL=efiling-return` | `efiling-audit`)

| Value                                                       | Where it comes from                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `FILING_EFILING_CLIENT_ID` / `FILING_EFILING_CLIENT_SECRET` | Issued when you onboard as a **Type-2 ERI** on the e-filing portal.                               |
| `FILING_EFILING_TOKEN_URL` / `FILING_EFILING_SUBMIT_URL`    | Supplied in the same ERI registration pack.                                                       |
| `FILING_EFILING_USERNAME` / `FILING_EFILING_PASSWORD`       | Optional; when set the transport uses a session (password) grant instead of `client_credentials`. |
| `FILING_SIGNING_URL` / `FILING_SIGNING_TOKEN`                | `efiling-audit` only. The CSP bridge / eSign / HSM endpoint that holds the DSC key and signs a digest. The app never holds the private key. |
| `FILING_SIGNING_USER` / `FILING_SIGNING_CERT_SERIAL`         | `efiling-audit` only. The DSC user/registration number and certificate serial the signing service should use. |

The ERI **field names** are configurable, so a pack that differs from the
defaults needs no code change: set `FILING_EFILING_TOKEN_FIELD`,
`FILING_EFILING_ACK_NUMBER_FIELD`, `FILING_EFILING_ACK_DATE_FIELD`,
`FILING_EFILING_STATUS_FIELD`, `FILING_EFILING_ERROR_CODE_FIELD`,
`FILING_EFILING_ERROR_MESSAGE_FIELD` (comma-separated dotted paths, first present
wins) and `FILING_EFILING_SUBMIT_BODY_KEY` (default `json`; blank posts raw). See
`.env.example`.

## 1. Validate in the sandbox first

Never make your first live call a production filing.

1. Point `FILING_IRP_BASE_URL` at the NIC sandbox (`https://einv-apisandbox.nic.in`)
   and use sandbox credentials.
2. Set the live env (section 2) but leave `FILING_GATEWAY=simulation` for normal
   traffic while you confirm the handshake with a single test IRN.3. Prepare one throwaway invoice and submit it through the campaign flow. Confirm
you get a real `Irn`/`AckNo` back and that the receipt's `provider` is
`live`.

Before touching the UI, run the operator conformance check. It exercises the
same gateway the app uses and exits non-zero on a failed handshake:

```bash
npm run filing:conformance                 # readiness + credential preflight
npm run filing:conformance -- --sign one.json    # DSC service signs a payload
npm run filing:conformance -- --submit one.json  # preflight, then ONE submission
```

Exit codes are contractual: `0` passed, `1` failed, `2` skipped because the
gateway is still `simulation`/`reference`. The `--submit` mode does not write a
filing run; it is the sandbox/pilot check, not the normal workflow.

## 2. Set the environment

In `.env` (never in the repo, never in the database):

```dotenv
FILING_GATEWAY=live
FILING_CHANNEL=irp-irn

FILING_GSTIN=27AAPFU0939F1ZV
FILING_IRP_BASE_URL=https://einvoice1.gst.gov.in
FILING_IRP_CLIENT_ID=...
FILING_IRP_CLIENT_SECRET=...
FILING_IRP_PORTAL_USER=...
FILING_IRP_PORTAL_PASSWORD=...
# Paste the PEM on ONE line with \n escapes; it is normalised at use.
FILING_IRP_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----"

FILING_TIMEOUT_MS=20000
```

For the income-tax channel, set `FILING_CHANNEL=efiling-return` and the
`FILING_EFILING_*` block instead. `efiling-audit` additionally requires the
`FILING_SIGNING_*` block below — the app refuses to boot without it, because an
unsigned audit return must never be transmitted:

```dotenv
FILING_CHANNEL=efiling-audit
FILING_SIGNING_URL=https://sign.internal.example/sign
FILING_SIGNING_TOKEN=...
FILING_SIGNING_USER=partner-1
FILING_SIGNING_CERT_SERIAL=1A2B3C
```

The signing service receives `{digest, algorithm:"SHA256withRSA", account}` for
the canonical payload and returns `{signatureBase64, certificateSerial, signedAt}`.
The detached envelope is stored in the filing proof bundle and sent with the
return. Confirm the `dsc` block/header names against your ERI registration pack
before the first live audit filing.

All secrets are read through `lib/env.ts` and never logged.

## 3. Confirm readiness before filing

Boot the app and read the readiness report:

```
GET /api/books/<bookId>/gst-filing?action=gateway-health
```

Expected: `provider: "live"`, `liveEligible: true`, and the `activeChannel`
showing `configured: true` with an empty `missing` list. If any credential is
missing the app will not have booted; if it booted with `live` but a channel
shows `configured: false`, the active channel and the credential block disagree
— fix the env and restart.

Then prove the credentials actually work. **Preflight** runs the portal auth
handshake and nothing else — no IRN is created, no return is lodged:

```
POST /api/books/<bookId>/gst-filing?action=gateway-preflight
```

`ok: true` means the client id/secret, the portal username/password and
`FILING_IRP_PUBLIC_KEY` were all accepted by the portal (for the ITD channel, the
token endpoint). `detail` carries the portal's own message on failure, and
`sandbox` tells you whether a green result was earned against a sandbox host or
production. The GST filing panel exposes the same check as a **Test live
credentials** button. A malformed `FILING_IRP_PUBLIC_KEY` is already rejected at
boot, so this only exercises what the portal accepts.

Once live, the scheduler (`SCHEDULER_ENABLED`) re-runs this preflight
periodically and alerts firm admins the moment the credentials stop working (and
again when they recover), so a revoked or rotated credential surfaces **before**
a due date, not on one. Probes are throttled to
`FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES` (default 60) so the portal is not hit
every tick; repeat alerts use `FILING_CREDENTIAL_ALERT_COOLDOWN_MINUTES` (default
360). Turn the job off with `FILING_CREDENTIAL_MONITOR_ENABLED=false`.

## 4. File the first return as a controlled pilot

Submit ONE campaign, watch the receipt, and reconcile the returned `ackNumber` /
`irn` against the portal before filing anything else. Treat the first live
filing on each channel as a pilot: the transports implement the published
shapes but have not been certified end-to-end against production.

## 5. Roll back instantly if needed

Filing mode is a single env value:

```dotenv
FILING_GATEWAY=simulation   # or reference, to transmit nothing at all
```

Restart. Campaigns already filed keep their stored `ackNumber`/`irn`; nothing is
retro-applied. `reference` is the safest holding state — it produces a
deterministic local acknowledgement and transmits nothing.

## How failures surface

| Symptom                                                             | Meaning / action                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process refuses to boot, `CredentialMissingError` listing variables | The named live credentials are absent. Set them (section 2) or switch the gateway.                                                                                                       |
| `CredentialMissingError` at submit time                             | The gateway was resolved before credentials were complete — restart with the full set.                                                                                                   |
| `PortalRejectionError [code]`                                       | The portal answered with a business rejection (bad invoice, GSTIN mismatch, duplicate IRN). Not retryable as-is; correct the payload — a corrected payload needs a **new** `once-token`. |
| `PortalTransportError`                                              | The request never reached the portal cleanly (DNS/TLS/timeout/5xx). Retryable with backoff; the `once-token` makes the retry idempotent.                                                 |
| IRP auth says the Sek could not be decrypted                        | `FILING_IRP_PUBLIC_KEY` does not match the IRP you are calling (wrong partition/key).                                                                                                    |
| Preflight returns `ok: false` with a portal message                 | The credentials or public key were rejected by the portal's auth call. Nothing was filed — fix the cause the message names and re-run preflight.                                         |

## What is still not certified

- Neither live transport has completed a production end-to-end filing. The
  credential handshake and public key are verifiable without filing (preflight),
  so the only unproven step is the first successful live submission; it stays
  reported by `gateway-health`, not hidden. In this checkout no FILING_*
  credentials are present, so the conformance runner reports `skipped` (exit 2)
  rather than claiming a green handshake.
- The DSC signing service is an integration seam: it is unit-tested against the
  documented request/response shape, but the specific CSP/eSign bridge and the
  portal's acceptance of the detached envelope must be proven with that
  provider's sandbox before the first live `efiling-audit` filing.
- The ITD ERI field names/paths are configurable because the full ERI
  specification is gated behind the e-filing portal; confirm them against your
  registration pack before the first live ITD filing.
- Portal version prefixes and the IRP public key are versioned by the portals —
  re-verify against the current IRP/ITD specification at each go-live.
