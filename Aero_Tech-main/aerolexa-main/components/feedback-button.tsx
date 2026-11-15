"use client";

import { Bug, Lightbulb, MessageSquareText, Send } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, useToast } from "@/components/ui/overlays";
import { api, errorMessage } from "@/lib/client/api";

/**
 * In-app feedback / bug report / feature request (Phase 5.2).
 *
 * One widget, three kinds. A feature request IS feedback, so they share an
 * inbox and a triage flow rather than three separate mechanisms that nobody
 * would maintain.
 *
 * The route is sent as context (query string stripped server-side) because
 * "it broke on the SQL tab" is the single most useful thing a bug report can
 * carry — and it is the one piece of context that is safe to collect, since the
 * path alone cannot identify a user.
 */

type Kind = "feedback" | "bug" | "feature";

const KINDS: { kind: Kind; label: string; icon: typeof Bug; hint: string }[] = [
  { kind: "feedback", label: "Feedback", icon: MessageSquareText, hint: "General comment" },
  { kind: "bug", label: "Bug", icon: Bug, hint: "Something is broken" },
  { kind: "feature", label: "Feature request", icon: Lightbulb, hint: "Something is missing" },
];

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("feedback");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const submit = async () => {
    const body = message.trim();
    // Mirrors the server's zod floor: fail in the UI rather than round-tripping
    // for a validation error we could have caught.
    if (body.length < 10) {
      toast({
        title: "Not enough detail",
        message: "Please add at least 10 characters so we can act on this.",
        type: "error",
      });
      return;
    }
    setBusy(true);
    try {
      await api("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          kind,
          message: body,
          context: { path: window.location.pathname, userAgent: navigator.userAgent.slice(0, 200) },
        }),
      });
      setMessage("");
      setOpen(false);
      toast({ title: "Thanks — sent to the team", type: "success" });
    } catch (err) {
      toast({ title: "Could not send feedback", message: errorMessage(err), type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<MessageSquareText aria-hidden className="size-3.5" />}
        onClick={() => setOpen(true)}
      >
        Feedback
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Send feedback"
        description="Bug reports and feature requests go to the same inbox — pick the closest match."
      >
        <div className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-2 text-caption font-medium text-muted">What kind of message is this?</legend>
            <div className="flex flex-wrap gap-2">
              {KINDS.map(({ kind: k, label, icon: Icon, hint }) => (
                <label
                  key={k}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    kind === k
                      ? "border-accent bg-accent/10 text-foreground"
                      : "border-line bg-surface text-muted hover:bg-surface-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="feedback-kind"
                    value={k}
                    checked={kind === k}
                    onChange={() => setKind(k)}
                    className="sr-only"
                  />
                  <Icon aria-hidden className="size-3.5" />
                  {label}
                  <span className="sr-only"> — {hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="feedback-message" className="mb-1.5 block text-caption font-medium text-muted">
              Details
            </label>
            <textarea
              id="feedback-message"
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={5_000}
              placeholder={
                kind === "bug"
                  ? "What did you expect, and what happened instead?"
                  : kind === "feature"
                    ? "What would you like the product to do?"
                    : "Anything you would like to tell us"
              }
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
              aria-describedby="feedback-message-hint"
            />
            <p id="feedback-message-hint" className="mt-1 text-caption text-muted">
              Your current page is attached. Please do not include customer data.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy || message.trim().length < 10}>
              <Send aria-hidden className="size-3.5" />
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
