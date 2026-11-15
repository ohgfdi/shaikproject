import { requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import type {
  AutoMatchOptions,
  BankFeedInput,
  BankMatchRuleInput,
  BankTransactionInput,
} from "@/lib/server/bank-feeds";
import {
  createBankFeed,
  listBankFeeds,
  getBankFeed,
  updateBankFeed,
  deleteBankFeed,
  createBankTransaction,
  listBankTransactions,
  bulkCreateBankTransactions,
  updateBankTransaction,
  createBankMatchRule,
  listBankMatchRules,
  updateBankMatchRule,
  deleteBankMatchRule,
  autoMatchBankTransactions,
  reconcileBankFeed,
} from "@/lib/server/bank-feeds";
import { assertBookTenant } from "@/lib/server/book-tenancy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const feedId = url.searchParams.get("feedId");

    if (action === "transactions" && feedId) {
      const matchStatus = url.searchParams.get("matchStatus") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const { transactions, total } = await listBankTransactions(ctx.workspace.id, params.id, feedId, {
        matchStatus,
        limit,
        offset,
      });
      return ok({ transactions, total, limit, offset });
    }

    if (action === "match-rules") {
      const activeOnly = url.searchParams.get("activeOnly") !== "false";
      const rules = await listBankMatchRules(ctx.workspace.id, params.id, activeOnly);
      return ok({ rules });
    }

    if (feedId) {
      const feed = await getBankFeed(ctx.workspace.id, params.id, feedId);
      return ok({ feed });
    }

    const reconciled =
      url.searchParams.get("reconciled") === "true"
        ? true
        : url.searchParams.get("reconciled") === "false"
          ? false
          : undefined;
    const feedType = url.searchParams.get("feedType") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { feeds, total } = await listBankFeeds(ctx.workspace.id, params.id, { reconciled, feedType, limit, offset });
    return ok({ feeds, total, limit, offset });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const action = body.action;

    if (action === "create-transaction") {
      const feedId = body.feedId as string;
      const { action: _, feedId: _f, ...input } = body;
      const tx = await createBankTransaction(
        ctx.workspace.id,
        params.id,
        feedId,
        input as unknown as BankTransactionInput,
        ctx.user.id,
      );
      return ok({ transaction: tx }, { status: 201 });
    }

    if (action === "bulk-transactions") {
      const feedId = body.feedId as string;
      const transactions = body.transactions as unknown as BankTransactionInput[];
      if (!feedId || !transactions) return toErrorResponse(new Error("feedId and transactions required"));
      const result = await bulkCreateBankTransactions(ctx.workspace.id, params.id, feedId, transactions, ctx.user.id);
      return ok({ created: result.count });
    }

    if (action === "create-rule") {
      const { action: _, ...input } = body;
      const rule = await createBankMatchRule(
        ctx.workspace.id,
        params.id,
        input as unknown as BankMatchRuleInput,
        ctx.user.id,
      );
      return ok({ rule }, { status: 201 });
    }

    if (action === "auto-match") {
      const feedId = body.feedId as string;
      const opts = {
        tolerance: body.tolerance,
        useRules: body.useRules,
        autoConfirm: body.autoConfirm,
      } as AutoMatchOptions;
      const result = await autoMatchBankTransactions(ctx.workspace.id, params.id, feedId, opts, ctx.user.id);
      return ok({ result });
    }

    if (action === "reconcile") {
      const feedId = body.feedId as string;
      if (!feedId) return toErrorResponse(new Error("feedId required"));
      const result = await reconcileBankFeed(ctx.workspace.id, params.id, feedId, ctx.user.id);
      return ok({ result });
    }

    // Create feed
    const { action: _a, feedId: _f2, ...feedInput } = body;
    const feed = await createBankFeed(ctx.workspace.id, params.id, feedInput as unknown as BankFeedInput, ctx.user.id);
    return ok({ feed }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const feedId = url.searchParams.get("feedId");
    const transactionId = url.searchParams.get("transactionId");
    const ruleId = url.searchParams.get("ruleId");

    const body = await readJsonBody<Record<string, unknown>>(request);

    if (feedId && !transactionId && !ruleId) {
      const feed = await updateBankFeed(ctx.workspace.id, params.id, feedId, body, ctx.user.id);
      return ok({ feed });
    }

    if (transactionId) {
      const tx = await updateBankTransaction(ctx.workspace.id, params.id, transactionId, body, ctx.user.id);
      return ok({ transaction: tx });
    }

    if (ruleId) {
      const rule = await updateBankMatchRule(ctx.workspace.id, params.id, ruleId, body, ctx.user.id);
      return ok({ rule });
    }

    return toErrorResponse(new Error("feedId, transactionId, or ruleId required"));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    await assertBookTenant(ctx, params.id);
    const url = new URL(request.url);
    const feedId = url.searchParams.get("feedId");
    const ruleId = url.searchParams.get("ruleId");

    if (feedId) {
      await deleteBankFeed(ctx.workspace.id, params.id, feedId, ctx.user.id);
      return ok({ deleted: true });
    }

    if (ruleId) {
      await deleteBankMatchRule(ctx.workspace.id, params.id, ruleId, ctx.user.id);
      return ok({ deleted: true });
    }

    return toErrorResponse(new Error("feedId or ruleId required"));
  } catch (err) {
    return toErrorResponse(err);
  }
}
