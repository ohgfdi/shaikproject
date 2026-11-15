# GSTN IRP sandbox onboarding (verify live filing, then switch to production)

This guide takes a deployment from "nothing configured" to a **verified** live
IRP handshake against the NIC **e-Invoice sandbox**, then flips to production.
It needs no production approval — the sandbox is where you earn confidence
first. See [`filing-go-live-runbook.md`](./filing-go-live-runbook.md) for the
wider go-live procedure and [`gst-portal-execution.md`](./gst-portal-execution.md)
for the transport detail.

## 1. Request sandbox credentials

1. Go to the NIC e-Invoice sandbox portal: `https://einv-apisandbox.nic.in`.
2. Register for API access and request credentials. You receive:
   - `client_id` / `client_secret` (the API app),
   - a sandbox **portal username / password** (the auth-handshake grant),
   - the sandbox **RSA public key**.
3. Note: the sandbox `AuthToken` is valid **60 minutes** (production is 360);
   the gateway refreshes 10 minutes before expiry either way.

## 2. Retrieve and format the RSA public key

The auth envelope is RSA-encrypted to the IRP's public key, so it must be
present and parseable — a malformed key is rejected **at boot**, not at filing.

- The key is an X.509 `PUBLIC KEY` PEM (a `-----BEGIN PUBLIC KEY-----` block),
  supplied by the portal/onboarding mail (or your GSP).
- Paste it into `.env` on **one line** with `\n` escapes:

  ```dotenv
  FILING_IRP_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIB…\n-----END PUBLIC KEY-----"
  ```

  The app restores the real newlines at use (`normalizePem`), so both the
  escaped one-liner and a real multi-line value work.

## 3. Configure the sandbox

```dotenv
FILING_GATEWAY=live
FILING_CHANNEL=irp-irn

FILING_GSTIN=<a sandbox GSTIN>
FILING_IRP_BASE_URL=https://einv-apisandbox.nic.in
FILING_IRP_CLIENT_ID=<sandbox client id>
FILING_IRP_CLIENT_SECRET=<sandbox client secret>
FILING_IRP_PORTAL_USER=<sandbox username>
FILING_IRP_PORTAL_PASSWORD=<sandbox password>
FILING_IRP_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"
FILING_TIMEOUT_MS=20000
```

The version-prefixed paths default to the current NIC shape; override them only
if your onboarding pins a different version:

```dotenv
FILING_IRP_AUTH_PATH=/eivital/v1.04/auth
FILING_IRP_ENDPOINT_PATH=/eicore/v1.03/Invoice
```

## 4. Verify the handshake (preflight)

This runs the auth exchange **only** — no IRN is created, nothing is filed:

```
POST /api/books/<bookId>/gst-filing?action=gateway-preflight
```

or click **Test live credentials** in the GST filing panel. Expect:

```json
{ "ok": true, "provider": "live", "channel": "irp-irn", "sandbox": true }
```

`ok: true` means the client id/secret, portal user/password and public key were
all accepted. `sandbox: true` confirms you are pointed at the sandbox.

## 5. File one test IRN

Create a campaign (GSTIN, period, due date) and Submit it. A successful response
stores a real `irn` and `ackNumber`. Confirm the values on the sandbox portal.
This exercises the full path: auth → AES-encrypted invoice → decrypted response.

## 6. Switch to production

1. Replace the sandbox values with the production ones and change the base URL to
   the taxpayer's IRP partition (`https://einvoice1.gst.gov.in` … `einvoice6`).
2. Restart. Boot re-validates the credentials and key (fail-closed).
3. Preflight again — expect `ok: true, sandbox: false`.
4. File one **pilot** return and reconcile the `irn`/`ackNumber` on the real
   portal before filing anything else.

## Troubleshooting

| Symptom                                            | Cause / fix                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Boot fails: not a valid RSA public key             | `FILING_IRP_PUBLIC_KEY` is malformed. Paste the full PEM (check the BEGIN/END lines) with `\n` escapes.                  |
| Preflight `ok:false`, auth error                   | Wrong client id/secret or portal user/password, or the wrong IRP partition. The `detail` carries the portal's message.   |
| Preflight `ok:false`, "Sek could not be decrypted" | The public key does not match the IRP you are calling (sandbox key against production, or the wrong partition).          |
| 404 on the auth or invoice path                    | Version prefix mismatch — set `FILING_IRP_AUTH_PATH` / `FILING_IRP_ENDPOINT_PATH` to the values in your onboarding pack. |

## What is verified vs. not

- **Verified by preflight:** credentials + public key + endpoint reachability.
- **Verified by the test/pilot IRN:** the full auth → encrypted-submit → decrypt
  round trip against a real portal.
- **Not proven until a credentialed production pilot:** the same round trip on the
  live IRP partition. `gateway-health` reports this honestly rather than hiding it.
