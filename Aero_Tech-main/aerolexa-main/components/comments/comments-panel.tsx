"use client";

import { MessageSquareText, Reply, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/overlays";
import { Avatar } from "@/components/ui/primitives";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { timeAgo } from "@/lib/format";
import type { CommentThreadItem } from "@/lib/types";

interface CommentInput {
  id: string;
  authorName: string;
  authorId: string;
  body: string;
  createdAt: string;
  parentId: string | null;
}

export function CommentsPanel({
  targetType,
  targetId,
  currentUserId,
  projectId: _projectId,
}: {
  targetType: "analysis" | "dashboard" | "report" | "presentation" | "insight";
  targetId: string;
  currentUserId?: string | null;
  projectId?: string | null;
}) {
  const [comments, setComments] = useState<CommentThreadItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ comments: CommentThreadItem[] }>(
        `/api/comments?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`,
      );
      setComments(data.comments);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [targetType, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: string, parentId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/comments", {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, body, parentId }),
      });
      setDraft("");
      setReplyTo(null);
      await load();
      toast({ title: "Comment posted", type: "success" });
    } catch (err) {
      setError(errorMessage(err));
      toast({ title: "Could not post comment", message: errorMessage(err), type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Delete this comment?",
      message: "It will be removed for everyone viewing this item.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api(`/api/comments/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const roots = comments?.filter((c) => !c.parentId) ?? [];
  const repliesOf = (id: string) => comments?.filter((c) => c.parentId === id) ?? [];

  return (
    <section aria-label="Comments" className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-h3 text-foreground">
        <MessageSquareText aria-hidden className="size-4 text-accent" />
        Discussion
        {comments ? (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption tabular-nums text-muted">
            {comments.length}
          </span>
        ) : null}
      </h2>

      <Card className="p-4">
        <label htmlFor={`comment-${targetId}`} className="sr-only">
          Add a comment
        </label>
        <textarea
          id={`comment-${targetId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={1}
          placeholder="Ask a question or leave feedback…"
          className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void post(draft, null)} disabled={!draft.trim()} loading={busy}>
            Post
          </Button>
        </div>
      </Card>

      {error && (
        <ErrorMessage title="Could not load comments" message={error} onRetry={() => void load()} className="mt-3" />
      )}
      {!comments && !error && (
        <div className="mt-3">
          <LoadingSkeleton rows={1} />
        </div>
      )}

      {comments && comments.length === 0 && (
        <Card className="mt-3">
          <EmptyState
            icon={MessageSquareText}
            title="No comments yet"
            description="Start the conversation about this item."
          />
        </Card>
      )}

      {roots.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">{roots.map((c) => renderComment(c, repliesOf(c.id), 0))}</ul>
      )}
    </section>
  );

  function renderComment(comment: CommentThreadItem, replies: CommentThreadItem[], depth: number): React.ReactNode {
    const isReplying = replyTo === comment.id;
    const isOwner = currentUserId === comment.authorId;
    const depthClass = depth === 0 ? "p-3.5" : `ml-9 mt-3 flex flex-col gap-2 border-l border-line pl-4`;

    return (
      <li key={comment.id} className={depth === 0 ? "card" : ""}>
        <div className="flex items-start gap-3">
          <Avatar name={comment.authorName} size={24} />
          <div className="min-w-0 flex-1 text-xs">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{comment.authorName}</span>
              <span className="text-caption text-muted">{timeAgo(comment.createdAt)}</span>
            </p>
            <p className="mt-1 whitespace-pre-wrap text-foreground truncate max-w-xs">{comment.body}</p>
          </div>
          <div className="ml-auto flex gap-1 text-caption">
            {(isOwner || !currentUserId) && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void remove(comment.id)}
                aria-label="Delete comment"
                title="Delete"
              >
                <Trash2 aria-hidden className="size-3.5" />
              </Button>
            )}
            {depth === 0 && !isReplying && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setReplyTo(isReplying ? null : comment.id)}
                aria-label={`Reply to ${comment.authorName}`}
                title="Reply"
              >
                <Reply aria-hidden className="size-3.5" />
              </Button>
            )}
            {isReplying && comment.id === replyTo && (
              <Button variant="ghost" size="sm" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                Cancel
              </Button>
            )}
          </div>
        </div>
        {replies.length > 0 && (
          <ul className={depthClass}>{replies.map((r) => renderComment(r, repliesOf(r.id), depth + 1))}</ul>
        )}
      </li>
    );
  }
}

export type { CommentInput };
