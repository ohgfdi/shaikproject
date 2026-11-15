# Privacy & Compliance

How Ledgerly handles personal data, what it deliberately does not do, and where
each control actually lives in the code.

The product is **self-hosted**. That single fact drives almost every decision
below: the operator of a deployment is usually also the data fiduciary for
their own firm, and there is no vendor relationship with us in the middle of
their books.

---

## 1. Scope

Two laws apply, and the stricter one governs:

| Law                       | Applies because                      | Where it binds hardest                                 |
| ------------------------- | ------------------------------------ | ------------------------------------------------------ |
| **DPDP Act 2023** (India) | Indian CA firms, the target market   | Consent registry, erasure, breach reporting            |
| **GDPR** (EU/EEA)         | Deployments serving EU data subjects | Portability, storage limitation, records of processing |

Where they conflict, the stricter obligation is implemented. The practical
differences are small: DPDP's consent registry and portability are close to
GDPR's, and DPDP's "reasonable security safeguards" language is satisfied by
the same controls as GDPR Art. 32.

---

## 2. Records of processing (GDPR Art. 30)

This section _is_ the record. It is maintained alongside the code, not in a
separate document that drifts.

### 2.1 Data we process

| Category                  | Models                                                                                             | Lawful basis        | Why                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Account identity**      | `User`, `ConsentRecord`                                                                            | Contract + consent  | Needed to operate the workspace; consent captured per purpose at signup                                               |
| **Customer data**         | `Dataset`, `Analysis`, `Dashboard`, `Report`, `Notebook`, `ModelVersion`, and their version tables | Contract            | This is the service. The operator uploads their own firm's data and processes it entirely inside their own deployment |
| **Derived content**       | `Insight`, `Chat`, `ChatMessage`, `Prompt`, `CustomMetric`, `Comment`                              | Contract            | Produced by the operator's use of the product                                                                         |
| **Activity / audit**      | `Activity`                                                                                         | Legal obligation    | The audit trail a firm produces for its own books. Retained regardless of plan                                        |
| **Operational telemetry** | `ErrorReport`, `SearchQueryLog`                                                                    | Legitimate interest | Debugging and product improvement. Redacted at capture; swept on a schedule                                           |
| **Billing**               | `Plan`, `Subscription`, `Invoice`                                                                  | Contract            | Where payments are enabled                                                                                            |
| **Communications**        | `Feedback`                                                                                         | Consent             | Customer correspondence and feature requests                                                                          |

### 2.2 Data we do NOT process

- **No third-party analytics.** No Google Analytics, no Mixpanel, no telemetry
  SDK. Usage analytics is computed in-app from our own tables
  (`lib/server/growth-funnel.ts`).
- **No third-party error tracking.** A hosted tracker (Sentry and friends)
  receives every stack frame, every URL — including `/apps/<shareToken>` and
  `/embed/<token>`, which _are_ the share capability — and every user's data
  shape. Error tracking is implemented in-app instead, redacted at capture
  (`lib/server/error-tracking.ts`).
- **No customer data leaves the deployment.** Uploads are read by an in-process
  DuckDB; the LLM provider is called server-side and is the operator's own
  configuration. There is no CDN, no font host, no analytics beacon — which is
  also why the CSP can keep `connect-src 'self'`.
- **No third-party fonts or scripts at runtime.** The Razorpay checkout script
  is the one exception, loaded on demand at the moment of payment and not
  present on any other route.

### 2.3 Processors

With the self-hosted model, the **deployment operator is their own processor**.
There is no sub-processor list to publish, because we operate no service that
touches a data subject's data on their behalf.

The one external party a deployment may optionally configure is the LLM
provider (`lib/server/llm`), which receives prompts the operator's users type.
This is a documented, operator-chosen disclosure: it is configured per
deployment, and turning the copilot off removes it.

---

## 3. Data-subject rights

| Right                    | Implementation                                         | Endpoint             |
| ------------------------ | ------------------------------------------------------ | -------------------- |
| **Access / portability** | `buildPortabilityBundle` — `lib/server/portability.ts` | `GET /api/me/export` |
| **Erasure**              | `eraseUser` — `lib/server/dpdp.ts`                     | `POST /api/me/erase` |
| **Consent withdrawal**   | `withdrawConsent` — `lib/server/dpdp.ts`               | `POST /api/consent`  |
| **Rectification**        | Profile fields are directly editable                   | `POST /api/me`       |
| **Consent proof**        | `ConsentRecord` rows are append-only, never deleted    | `GET /api/consent`   |

### 3.1 Portability

The bundle is a single JSON file containing every row tied to the data
principal: authored content (notebook cells, chat transcripts, report sections,
analysis configs, DAX measures), memberships, consents, activity, billing and
notifications.

Three properties are enforced by test, not by convention
(`__tests__/unit/privacy-controls.test.ts`):

1. **Credentials are withheld and the withholding is disclosed.** The manifest
   ships `withheldFields` and `notExported`, each with a reason. `passwordHash`,
   OTP hashes, reset-token hashes, the encrypted `Connector.config` blob (which
   decrypts to a live database password) and server filesystem paths are all
   excluded. A portability bundle is a file that gets emailed to a subject and
   lives in their Downloads folder forever — handing someone their own password
   hash hands them an offline cracking target, and handing them a connector
   credential hands them production database access. DPDP §11 is about data,
   not secrets.
2. **Sections are isolated.** A section that fails is recorded in the manifest
   with its error and exported as `null`. A principal is never left with nothing
   because one table was unreadable, and they can always see what is missing.
3. **Coverage is checked against the schema.** The test parses
   `prisma/schema.prisma` and fails if any model holding personal data is
   neither exported, nor declared in `PROFILE_MODELS`, nor justified in
   `NOT_EXPORTED`. Adding a model to the schema without deciding how it is
   handled is a test failure.

Scoping is deliberately split: workspace-scoped collections use the principal's
own workspace, and per-person collections (chats, saved searches, notifications,
search history, feedback, error reports) are scoped by `userId` so a future org
seat cannot leak a colleague's conversation into an export.

> **A note on the bug this replaced.** Every workspace-scoped section was
> originally `where: workspaceId ? { workspaceId } : {}`. In Prisma an empty
> `where` means **every row in the table**, so a user without a personal
> workspace received every dataset, analysis, report and notebook in the entire
> installation. The fix is `wsScope()`, which matches nothing in that case. The
> regression test for it is `exports nothing when the principal has no
workspace`.

### 3.2 Erasure

`eraseUser()` revokes API keys, removes org/project memberships, deletes the
personal workspace (cascading every artifact), anonymizes the identity row, and
clears verification tokens.

The `User` row is **anonymized, not deleted** — artifact foreign keys are
`onDelete: Restrict` by design, and DPDP erases personal data, not a firm's
business records. Anonymization achieves the statutory goal: the email is
rewritten to a deterministic `deleted-user-<hash>@erased.invalid`, the password
hash becomes an unmatchable sentinel, and all profile fields are nulled.

Firm artifacts the user created are preserved with `createdById` retained
against the anonymized row. That is the correct reading of the obligation, and
the audit trail stays internally consistent without retaining personal data.

---

## 4. Storage limitation (GDPR Art. 5(1)(e))

The one GDPR principle that is purely a deletion duty, and the one self-hosted
software most often fails. Consent and erasure were implemented; **nothing
deleted anything on its own**, so an account that never logged in again kept
its error reports, search log, delivery logs and expired auth tokens forever.

`lib/server/retention.ts` runs a declarative sweep daily from the scheduler
tick (`lib/server/scheduler.ts`), isolated so a failing policy cannot block the
rest.

| Policy                      | Window                        | Basis                                                                                                            |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Resolved error reports      | 90 days after last occurrence | Debugging value is exhausted once triaged                                                                        |
| Untriaged error reports     | 180 days                      | An unfixed error seen for six months is either fixed or not actionable                                           |
| Search-query log            | 180 days                      | Pure analytics, and the terms users search are themselves sensitive (client names, PAN numbers)                  |
| Webhook delivery records    | 90 days                       | De-duplication only needs a short replay window                                                                  |
| Terminal job-queue rows     | 30 days after completion      | Reclaims space; the run result lives on the artifact it produced                                                 |
| Read notifications          | 180 days                      | Inbox history, not a record                                                                                      |
| Expired verification tokens | Immediately on expiry         | An expired token can never authenticate anything, and an unexpired one is a live credential that must not linger |
| Expired phone OTPs          | 7 days after expiry           | Short abuse-investigation window                                                                                 |

**Deliberately never swept:**

- `Activity` — the statutory audit trail for a firm doing books. Retention is a
  jurisdiction-specific period, not a default. A generic "delete old rows" pass
  would quietly destroy the compliance record this product exists to produce.
- `ConsentRecord` — the Act requires _proof_ of what a user consented to, so the
  record must outlive the consent.
- `Feedback` — customer correspondence.

Every policy carries a stated `basis`. A retention window with no justification
is an arbitrary deletion, which is exactly what a regulator challenges, and the
test suite asserts each basis is non-empty.

---

## 5. Security controls

### 5.1 Transport

| Control                                            | Where                            | Notes                                                                                                                                                                        |
| -------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HSTS (2 years, `includeSubDomains`, `preload`)     | `lib/server/security-headers.ts` | **Production only.** Sending it over plain HTTP in development pins `localhost` to HTTPS in the developer's browser for a year — a genuinely painful self-inflicted foot-gun |
| TLS termination                                    | Reverse proxy                    | See §7                                                                                                                                                                       |
| `Referrer-Policy: strict-origin-when-cross-origin` | `security-headers.ts`            | Not cosmetic here: `/apps/<shareToken>` and `/embed/<token>` put share tokens in the **path**, so referrer leakage is a real data leak for this app specifically             |

### 5.2 Content Security Policy

CSP is **nonce-based, not `'unsafe-inline'`**. The nonce is 16 bytes from
`crypto.getRandomValues` (not `Math.random` — a predictable nonce is
equivalent to no CSP at all) and is passed to the render via `x-csp-nonce`.
`'unsafe-eval'` is development-only, for React Refresh.

The one inline `<script>` in the app is the JSON-LD structured-data block on
`app/templates/[id]`. That page is statically generated, so it cannot receive a
per-request nonce; those blocks are authorised by **SHA-256 hash** instead,
which is strictly stronger than `'unsafe-inline'` because the hash only matches
that exact byte sequence.

The hashes are generated (`npm run generate:jsonld-hashes`) from the same
`templateJsonLd` helper the page renders, so the policy cannot drift from the
markup. They are stored **bare** and quoted only in the CSP — a bare token
renders unquoted and browsers ignore it, silently killing structured data.
`scripts/verify-csp-live.mts` boots the production server and asserts exactly
that, because no unit test can catch a quoting regression.

### 5.3 Authorization

- Middleware verifies the cookie's **signature only** (Edge runtime, no DB).
  Revocation via `sessionVersion` is enforced in `readSession()` on every server
  component and route handler. This is a deliberate parity contract: a revoked
  session may still render a protected page shell from cache, but every data
  fetch inside it 401s. Do not "optimise" the route guards by assuming
  middleware already checked.
- `requirePageAuth()` guards pages; `requireAuth()`/`requireModule()` guard APIs.
- Module gates (`LEDGERLY_PROFILE`) freeze whole feature surfaces — nav, pages
  and APIs together — rather than hiding a link while leaving the route open.

### 5.4 Secrets

`Connector.config` is encrypted at rest (`lib/server/connectors/crypto.ts`) and
is excluded from exports, logs and the error tracker. Connector credentials are
never returned to the browser.

---

## 6. Error tracking without a vendor

`lib/server/error-tracking.ts` captures client errors in-app. The privacy
properties are enforced at capture time, not by policy:

- **Redaction before storage.** Emails, bearer tokens, query-string secrets,
  cuids, UUIDs and long opaque tokens are replaced. The default stack frames are
  relative to the app root, so absolute build paths never land in the DB.
- **Query strings are stripped** from stored paths — `/apps/<token>` and
  `/embed/<token>` are capabilities, and a query string is where tokens hide.
- **Bounded cardinality.** Reports are grouped by a 32-character fingerprint
  over the error name plus the top three frames, so 10,000 distinct errors
  collapse into a handful of rows.
- **It can never throw.** The tracker must not fail the request it observes.

---

## 7. Deploying over HTTPS

The app sets HSTS but does **not** terminate TLS. A self-hosted deployment needs
a reverse proxy in front of it. A minimal nginx configuration:

```nginx
server {
  listen 443 ssl http2;
  server_name ledgerly.example.com;

  ssl_certificate     /etc/letsencrypt/live/ledgerly.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/ledgerly.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    # X-Forwarded-For is read by /api/me/erase to hash the request IP for the
    # consent/erasure proof. Without it that proof records nothing.
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;   # Next.js HMR in dev
    proxy_set_header Connection        "upgrade";
  }
}

server {
  listen 80;
  server_name ledgerly.example.com;
  return 301 https://$host$request_uri;
}
```

Two deployment notes that are easy to miss:

- **`X-Forwarded-For` must be set.** It is the only source of the request IP,
  and the IP is hashed into the consent and erasure records as proof.
- **Disable `AUTH_COOKIE_SECURE=false`.** The session cookie is `Secure` by
  default; the override exists only for the test harness replaying cookies over
  plain `http://127.0.0.1`.

Check the result:

```bash
curl -sSI https://ledgerly.example.com/login | grep -iE 'strict-transport|content-security|x-frame'
```

---

## 8. Honest gaps

Stated plainly, because a compliance document that claims full coverage is
worse than none:

- **No breach-notification automation.** DPDP requires notifying the Data
  Protection Board and affected principals within 72 hours. The controls that
  _detect_ and _limit_ a breach exist; the notification workflow is manual.
- **No cookie consent banner.** There is exactly one cookie — the session —
  and it is strictly necessary, so no consent gate is required. This is a
  defensible reading, not an oversight, but it is a reading.
- **No DPO tooling or data-subject-request ticketing.** Requests are handled
  through the same support channel as everything else.
- **`Activity` retention is unspecified.** The sweep deliberately leaves it
  alone, so its growth is unbounded. The correct value is jurisdiction-specific
  (India's Companies Act books-retention periods differ from a GDPR operator's
  needs) and is an operator decision, not a default we should pick.
- **Sub-processors are the operator's problem.** If a deployment configures a
  third-party LLM provider, the operator — not Ledgerly — carries the processor
  disclosure obligation for it.
