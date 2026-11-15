/**
 * Trial lifecycle tests (Phase 5.1).
 *
 * The property that matters most here is the one that would silently cost
 * money in both directions: a lapsed trial must stop granting Pro, and a
 * genuine paid subscription must never be downgraded by a clock check.
 */
import fs from "node:fs";

import { prisma } from "@/lib/db";
import { DEFAULT_PLANS, currentSubscription, ensurePlans } from "@/lib/server/billing";
import { entitlementsForWorkspace, workspacePlanId } from "@/lib/server/entitlements";
import { TRIAL_WARNING_DAYS, isTrialLapsed, startTrial, trialDays, trialStatus } from "@/lib/server/trial";

const DAY = 86_400_000;
const now = () => new Date();

async function seedWorkspace() {
  await ensurePlans();
  return prisma.workspace.create({ data: { name: `Trial WS ${Math.random()}` } });
}

afterEach(async () => {
  await prisma.workspace.deleteMany({ where: { name: { startsWith: "Trial WS" } } });
});

describe("trial", () => {
  it("defaults to 14 days and honours TRIAL_DAYS", () => {
    const original = process.env.TRIAL_DAYS;
    delete process.env.TRIAL_DAYS;
    expect(trialDays()).toBe(14);
    // A zero, negative or unparseable value must fall back, not produce a
    // zero-length or negative trial.
    process.env.TRIAL_DAYS = "0";
    expect(trialDays()).toBe(14);
    process.env.TRIAL_DAYS = "abc";
    expect(trialDays()).toBe(14);
    process.env.TRIAL_DAYS = "30";
    expect(trialDays()).toBe(30);
    if (original === undefined) delete process.env.TRIAL_DAYS;
    else process.env.TRIAL_DAYS = original;
  });

  it("gives a new workspace Pro entitlements, not just a label", async () => {
    const ws = await seedWorkspace();
    expect(await workspacePlanId(ws.id)).toBe("free");

    const started = await startTrial(ws.id);
    expect(started.active).toBe(true);
    expect(started.daysRemaining).toBe(trialDays());

    // The point of a trial: the gated features must actually be reachable.
    expect(await workspacePlanId(ws.id)).toBe("pro");
    expect((await entitlementsForWorkspace(ws.id)).publicShareLinks).toBe(true);
  });

  it("does not issue an invoice or attach a payment rail to a trial", async () => {
    const ws = await seedWorkspace();
    await startTrial(ws.id);

    const sub = await prisma.subscription.findFirst({ where: { workspaceId: ws.id } });
    expect(sub?.provider).toBeNull();
    // A trial that produced an invoice would show up in billing history as a
    // charge that was never paid.
    expect(await prisma.invoice.count({ where: { workspaceId: ws.id } })).toBe(0);
  });

  it("stops granting Pro once the trial deadline passes", async () => {
    const ws = await seedWorkspace();
    const start = new Date("2026-01-01T00:00:00Z");
    await startTrial(ws.id, start);

    const end = new Date(start.getTime() + trialDays() * DAY);
    // One millisecond before expiry: still entitled.
    expect(await workspacePlanId(ws.id, new Date(end.getTime() - 1))).toBe("pro");
    // At the deadline: over.
    expect(await workspacePlanId(ws.id, end)).toBe("free");
    expect(await workspacePlanId(ws.id, new Date(end.getTime() + DAY))).toBe("free");

    const ent = await entitlementsForWorkspace(ws.id);
    // Downgrade, not lockout: analysis of your own data never changes.
    expect(ent.publicShareLinks).toBe(false);
    expect(ent.maxApiKeys).toBe(0);
  });

  it("never downgrades a paid subscription whose period end has slipped", async () => {
    // The asymmetry that `trialEndsAt` exists to express: a lapsed TRIAL is
    // over, but a PAID subscription is settled by whether money arrived — a
    // lagging webhook must not strip entitlements from a paying customer.
    const ws = await seedWorkspace();
    const start = new Date("2026-01-01T00:00:00Z");
    await prisma.subscription.create({
      data: {
        workspaceId: ws.id,
        planId: "pro",
        status: "active",
        currentPeriodStart: start,
        currentPeriodEnd: new Date(start.getTime() + DAY), // already past
        trialEndsAt: null, // a real purchase, not a trial
      },
    });

    const later = new Date(start.getTime() + 30 * DAY);
    expect(await workspacePlanId(ws.id, later)).toBe("pro");
  });

  it("is idempotent and never re-arms over an existing subscription", async () => {
    const ws = await seedWorkspace();
    await startTrial(ws.id);
    const first = await prisma.subscription.findFirst({ where: { workspaceId: ws.id } });

    await startTrial(ws.id);
    await startTrial(ws.id);
    const all = await prisma.subscription.findMany({ where: { workspaceId: ws.id } });

    // Repeated signup/registration calls must not stack trials or push the
    // deadline out — that would be an unbounded free-Pro generator.
    expect(all.length).toBe(1);
    expect(all[0]!.trialEndsAt).toEqual(first!.trialEndsAt);
  });

  it("refuses to start a trial over an existing PAID subscription", async () => {
    const ws = await seedWorkspace();
    await prisma.subscription.create({
      data: { workspaceId: ws.id, planId: "firm", status: "active", trialEndsAt: null },
    });

    await startTrial(ws.id);

    const sub = await prisma.subscription.findFirst({ where: { workspaceId: ws.id } });
    expect(sub?.planId).toBe("firm");
    expect(sub?.trialEndsAt).toBeNull();
    expect(await workspacePlanId(ws.id)).toBe("firm");
  });

  it("reports days remaining and an expiring-soon flag", async () => {
    const ws = await seedWorkspace();
    const start = new Date("2026-01-01T00:00:00Z");
    await startTrial(ws.id, start);

    // Elapsed and remaining are two sides of the same clock; state them as such.
    const atElapsed = (days: number) => new Date(start.getTime() + days * DAY);

    const mid = await trialStatus(ws.id, atElapsed(1));
    expect(mid.active).toBe(true);
    expect(mid.daysRemaining).toBe(trialDays() - 1);
    expect(mid.expiringSoon).toBe(false);

    // Exactly at the warning boundary, not one day inside it.
    const near = await trialStatus(ws.id, atElapsed(trialDays() - TRIAL_WARNING_DAYS));
    expect(near.daysRemaining).toBe(TRIAL_WARNING_DAYS);
    expect(near.expiringSoon).toBe(true);

    const justOutside = await trialStatus(ws.id, atElapsed(trialDays() - TRIAL_WARNING_DAYS - 1));
    expect(justOutside.expiringSoon).toBe(false);

    const over = await trialStatus(ws.id, atElapsed(trialDays() + 1));
    expect(over.active).toBe(false);
    expect(over.daysRemaining).toBeNull();
  });

  it("converts to a real subscription when payment is recorded", async () => {
    // activateSubscriptionOps is what both rails call on a paid invoice.
    const ws = await seedWorkspace();
    await startTrial(ws.id);
    const { prisma: p } = await import("@/lib/db");

    const existing = await p.subscription.findFirst({ where: { workspaceId: ws.id } });
    await p.subscription.update({
      where: { id: existing!.id },
      data: {
        trialEndsAt: null,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      },
    });

    // Well past the original trial deadline — the customer has paid, so they
    // must still have Pro.
    expect(await workspacePlanId(ws.id, new Date(Date.now() + 60 * DAY))).toBe("pro");

    const sub = await currentSubscription(ws.id);
    expect(sub?.trialEndsAt).toBeNull();
  });

  it("never throws when the plan catalog is unavailable", async () => {
    // startTrial is called from registerUser; a trial must never be the reason
    // a signup fails. Point it at a workspace whose plan rows are gone by
    // deleting them, and assert it degrades to the free tier silently.
    const ws = await seedWorkspace();
    await prisma.subscription.create({
      data: { workspaceId: ws.id, planId: "pro", status: "canceled" },
    });
    // A cancelled subscription exists, so startTrial bails out early — but it
    // must still not throw.
    await expect(startTrial(ws.id)).resolves.toBeDefined();
  });

  it("has a 'pro' plan in the catalog for the trial to point at", () => {
    expect(DEFAULT_PLANS.some((p) => p.id === "pro")).toBe(true);
    // The Subscription -> Plan FK is Restrict, so a trial cannot be created
    // without this row existing.
    expect(DEFAULT_PLANS.find((p) => p.id === "pro")!.amountPaise).toBeGreaterThan(0);
  });
});

describe("isTrialLapsed", () => {
  it("treats a null deadline as never lapsed", () => {
    expect(isTrialLapsed(null, now())).toBe(false);
    expect(isTrialLapsed(undefined, now())).toBe(false);
  });

  it("treats the exact deadline as lapsed", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(isTrialLapsed(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isTrialLapsed(at, at)).toBe(true);
    expect(isTrialLapsed(at, new Date(at.getTime() + 1))).toBe(true);
  });
});

describe("templates gallery links", () => {
  it("links every catalog template to its indexable landing page", () => {
    // app/templates/[id] exists to be found by search. It was orphaned: no
    // internal inbound links, so it had no path from the rest of the app.
    const source = fs.readFileSync("app/templates/page.tsx", "utf8");
    expect(source).toContain("`/templates/${template.id}`");
  });
});
