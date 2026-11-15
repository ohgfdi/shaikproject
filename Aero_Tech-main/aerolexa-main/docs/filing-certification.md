# Filing certification record

`docs/gst-portal-execution.md` reports what the gateway implements;
`docs/filing-go-live-runbook.md` is the operator procedure. This file is the
**evidence record** that turns those into a certified deployment.

The app shows the same checklist at **Compliance → Filing runs → Filing
certification** (`lib/server/filing-certification.ts`). A live gateway with valid
credentials and no reconciled submission is displayed as **Pilot — not
certified**; only stored, reconciled live filings produce **Certified**.

## Verdict rules

| Verdict      | Requires                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| `simulation` | Nothing. `FILING_GATEWAY` is unset, `reference` or `simulation`; nothing was transmitted.    |
| `pilot`      | `FILING_GATEWAY=live`, the active channel's credentials are complete, but no reconciled live filing is on record. |
| `certified`  | The above, **plus** at least one filed run whose stored proof bundle names `provider: "live"`, **plus** at least one run with `verificationStatus = "verified"`. |

The handshake step is only marked done by a completed live submission. Running
the preflight proves credentials without filing, but the result is not stored as
evidence; record it below when you run it.

## Evidence to collect (one row per channel)

| Field                        | Where it comes from                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| Channel                      | `FILING_CHANNEL` (`irp-irn`, `efiling-return`, `efiling-audit`)        |
| Environment                  | NIC sandbox host vs production host (`gateway-health` reports it)      |
| Credential preflight         | `POST /api/books/<id>/gst-filing?action=gateway-preflight` → `ok: true` |
| Conformance run              | `npm run filing:conformance -- --submit one.json` → exit 0             |
| First live reference         | IRN / ARN / SRN returned by the portal                                 |
| Proof bundle digest          | `ComplianceFilingRun.proofDigest` after the submission                 |
| Proof verification           | `/verify/filing-proof` returns **Proof verified** for the exported bundle |
| Reconciliation verdict       | `verificationStatus = "verified"` on the same run                      |
| Operator, date               | Who filed, and when                                                    |

## Record template

```markdown
### <Channel> — <sandbox|production>

- Credentials complete: yes / no (missing: …)
- Preflight: ok at <timestamp>, portal message: <…>
- Conformance runner: exit <0|1|2> at <timestamp>
- First submission: <IRN/ARN/SRN>, <timestamp>, actor <name>
- Proof digest: <sha256>
- Independent verification: passed / failed (check id that failed: …)
- Reconciliation: verified / unverified / defective at <timestamp>
- Notes: version prefix used, portal messages, anything re-verified
```

## Rules

1. **One channel at a time.** `irp-irn` and `efiling-return` have different
   credentials and different failure modes; certify them separately.
2. **Never certify from a simulation receipt.** The verifier and the checklist
   both refuse to count it, and so must the record.
3. **Keep the proof bundle.** Export it (payload + receipt + digests + signature)
   and verify it at `/verify/filing-proof` before marking the row. A certificate
   without the evidence is just a claim.
4. **Re-certify after a portal version change.** The IRP/ITD paths and public key
   are versioned by the portals; a green record from last quarter is not proof
   for this one.
5. **A rejected submission is evidence too.** Record the portal's business
   rejection and the corrected re-submission; it demonstrates the failure path
   works.
