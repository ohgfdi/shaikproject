# Filing canary rehearsal

`npm run filing:canary` produces one JSON evidence file for a proposed filing.
It does not touch the database and does not submit unless asked.

```bash
# Read-only rehearsal: readiness + shadow plan + (live) credential preflight.
npm run filing:canary -- --payload verification/gstr1.json

# Explicit submission. A live gateway additionally needs both the flag and env.
CANARY_ALLOW_LIVE=true npm run filing:canary -- --payload verification/gstr1.json --submit --confirm-live
```

Output defaults to `verification/filing-canary-<timestamp>.json`; override with
`--out path.json`.

## What it proves — and what it does not

| Included | Not included |
|---|---|
| Active provider/channel and credential completeness | That the portal accepted a document (unless `--submit` returned a receipt) |
| DSC signing readiness for `efiling-audit` | A legal opinion |
| Canonical payload digest and idempotency token | A database filing-run record |
| Blockers that would stop a live submission | Reconciliation of an acknowledgement |

## Safety

- No submission by default.
- A live submission requires `--confirm-live` **and** `CANARY_ALLOW_LIVE=true`;
  either one alone is refused with exit code 2.
- Exit codes: `0` evidence produced, `1` requested submission failed, `2` refused
  or the payload could not be read.

## Sequence for promoting a client

1. Rehearse with the client's payload and fix every `plan.blockers`.
2. Run `npm run filing:conformance` against the live channel.
3. Promote one client through `/api/organization/engagements/:id/filing-go-live`
   (blockers are refused; an override needs a written note).
4. Submit that client's first run, then reconcile the acknowledgement before
   promoting the next client.
