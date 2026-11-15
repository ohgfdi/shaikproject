# Pilot runbook — first firm on the hosted instance

**Goal:** three CA firms using the product on real client data for 30 days, with
one reconciled GST filing and one paying subscription. Everything here is
operational; feature coverage is tracked separately in
[`capability-scorecard.md`](./capability-scorecard.md).

Run the gate before each step is considered done:

```bash
npm run pilot:readiness          # human checklist; exit 1 while blocked
npm run pilot:readiness -- --json  # the same snapshot, for a ticket
```

Blockers are conditions a pilot cannot start with. Warnings must be stated out
loud in the pilot agreement — an unstated warning is how a pilot becomes an
incident.

---

## 1. Hosted instance (one VPS, one domain)

Follow [`deploy-hosted-vps.md`](./deploy-hosted-vps.md) step by step. Then:

```bash
npm run preflight:prod       # DB, RLS consistency, migrations, backups, queue, mail, filing
npm run drill:backup         # prove a restore, write data/backup-drill.json
npm run audit                # production dependency scan
```

Non-negotiables for a pilot (the app refuses to boot without most of these):

| Setting                           | Why                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL` → PostgreSQL       | SQLite cannot run RLS, and a pilot is not a single-user dev box                                                                      |
| `MAIL_TRANSPORT=smtp` + `SMTP_*`  | Invitations and approvals must actually reach a client                                                                               |
| `AUTH_REQUIRE_EMAIL_VERIFY=true`  | An unverified signup must not become a client workspace                                                                              |
| `JOB_WORKER_ENABLED=true`         | Or run `npm run worker` as a separate process and leave it `false` on web replicas                                                   |
| `NEXT_PUBLIC_APP_URL=https://…`   | Share links and receipts are useless if they point at localhost                                                                      |
| `METRICS_TOKEN`                   | `/api/metrics` and `/api/ops/alerts` stay off the network without it                                                                 |     | `ANTHROPIC_API_KEY` (optional) | Copilot fails honestly without it; deterministic engines still answer |
| `FIRM_HOME=compliance` (optional) | Send users attached to a firm to the statutory calendar instead of the analytics home. Default `analytics`; reversible per instance. |

**Isolation posture — say this to the firm.** Database-level RLS is _not_
enforced: `RLS_QUERY_LAYER_WIRED = false` and `npm run tenancy:audit` reports
unwrapped tenant files. Isolation is enforced in the application layer
(`lib/auth/guard.ts`, `lib/server/members.ts`, `lib/server/dataset-access.ts`).
Do not describe the pilot as "RLS-isolated". Put the audit number in the pilot
agreement. When the wrapping work lands, flip the flag and the docs together.

## 2. Narrow the wedge

A pilot firm should see the job it bought, not 47 pages. Set the profile per
instance (or per deployment) before inviting anyone:

```dotenv
LEDGERLY_PROFILE=pro     # full analyst toolkit (default)
LEDGERLY_PROFILE=core    # minimal core flow only
```

For a GST/recon pilot, keep `pro` and walk the firm through exactly one path:

```
Tally / Zoho Books  →  dataset profile  →  GST recon analysis
                    →  client report    →  portal invite  →  filing (shadow first)
```

Open items that need a human decision, not code:

- **Brand.** The package, README and code say **Ledgerly**; `PRODUCT_OVERVIEW.md`
  and several docs say **Aerolexa**. Env vars honour both spellings. Pick one
  before a contract is signed.
- **Pricing.** Confirm the ₹999 / ₹4,999 tiers against the pilot firm's size;
  `PLAN_ENTITLEMENTS` and the upgrade copy already implement them.

## 3. Filing — shadow first, one live submission

Follow [`filing-go-live-runbook.md`](./filing-go-live-runbook.md). The sequence
is not optional:

1. `FILING_GATEWAY=simulation` for the whole first week. Nothing is transmitted;
   the full lifecycle runs offline.
2. Collect credentials: IRP client id/secret + portal user/password + the IRP
   public key, **or** Type-2 ERI onboarding for income tax. These come from the
   portals and have their own lead time — request them on day one.
3. `npm run filing:conformance` → preflight green against the sandbox.
4. One live submission per channel, under a manager override, and reconcile the
   returned IRN/ack against the portal before anything else.
5. Promote a client from `shadow` to `live` only after that reconciliation
   (`GET …/filing-go-live` lists every remaining blocker). Receipts are v3
   signed when `FILING_SIGNING_*` is configured; without it they are v2, and
   that must be disclosed.

`pilot:readiness` warns while the live gateway has transmitted but never
reconciled a filing — that is the definition of an unproven transport.

## 4. Onboarding and support loop

1. Create the firm organization and import the client list in one transaction:
   `POST /api/organization/engagements/import` (all-or-nothing, line-numbered
   errors).
2. Invite one named client contact; confirm the magic link arrives and the
   invite panel shows `deliveryStatus: sent`.
3. Upload one real client file. Confirm the data-quality warnings and the
   provenance label on every number.
4. Run the weekly review from `/api/metrics` + `/api/ops/alerts` + the in-app
   error reports. Route every pilot issue to a named owner; do not file them as
   feature requests.

**Exit criteria for the 30-day pilot:** uptime ≥ 99.5%, one real IRN issued and
reconciled (or a written decision to stay in simulation for this cycle), all
three firms active in the last 7 days, and one subscription conversation opened.

## 5. Rolling back

| Situation                      | Action                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Bad deploy                     | Redeploy the previous image; migrations are forward-only — take a dump first                             |
| Filing problem                 | `FILING_GATEWAY=reference` (transmits nothing) and restart                                               |
| Mail outage                    | Messages queue in `MailOutbox` with backoff; fix SMTP and they drain                                     |
| Suspected tenant leak          | Take the instance offline, preserve logs, run `npm run tenancy:audit`; do not raise RLS_ENABLED as a fix |
| RLS_ENABLED was set by mistake | Unset it and restart — with the layer unwired the policies hide every row                                |

## What this runbook does not do

- It does not obtain portal credentials, DNS, or Razorpay KYC — those are
  external and have lead times.
- It does not enable database-level RLS; that requires the wrapping work and a
  non-owner database role, and is tracked in the scorecard as PARTIAL.
- It does not certify the live filing transports. One reconciled submission per
  channel does that, and only then may the word "certified" be used.
