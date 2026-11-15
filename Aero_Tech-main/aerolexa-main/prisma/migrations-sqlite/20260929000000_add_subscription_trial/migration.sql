-- Phase 5.1: time-limited Pro trial.
--
-- A trial is a paid entitlement on a timer, so it needs a deadline the billing
-- layer can read. It is stored as its own column rather than inferred from
-- `currentPeriodEnd` because the two cases must be treated differently:
--
--   * a TRIAL that ran out  -> stop granting Pro entitlements, immediately.
--   * a PAID subscription whose period has lapsed while a webhook is in
--     flight -> still entitled; the operator's payment is the source of truth
--     and a local clock check must not silently downgrade a paying customer.
--
-- Nullable: NULL means "not a trial", which is every pre-existing row.

ALTER TABLE "Subscription" ADD COLUMN "trialEndsAt" DATETIME;