"use client";

import { CheckCircle2, Clock, CreditCard, IndianRupee, Landmark } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";

interface PlanDto {
  id: string;
  name: string;
  description: string | null;
  amountPaise: number;
  currency: string;
  interval: string;
  features: string[];
}

interface BillingState {
  razorpayConfigured: boolean;
  current: {
    planId: string;
    planName: string;
    status: string;
    currentPeriodEnd: string | null;
    isTrial?: boolean;
  } | null;
  trial: { active: boolean; daysRemaining: number | null; endsAt: string | null; expiringSoon: boolean };
  plans: PlanDto[];
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

/**
 * Billing panel (Band 4.2). Two rails, honestly labelled: Razorpay checkout
 * when the gateway is configured, and a manual offline-transfer request that
 * stages an invoice for an operator. The Free plan needs neither.
 */
export function BillingPanel() {
  const { toast } = useToast();
  const [state, setState] = useState<BillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api<BillingState>("/api/billing/plans");
      setState(data);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkout = async (planId: string, interval: "month" | "year") => {
    setBusyPlan(planId);
    setError(null);
    try {
      const order = await api<{ id: string; amount: number; currency: string; invoiceId: string; keyId: string }>(
        "/api/billing/checkout",
        { method: "POST", body: JSON.stringify({ planId, interval }) },
      );
      if (!window.Razorpay) {
        // Load Checkout.js on demand — never bundled into the route.
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://checkout.razorpay.com/v1/checkout.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Could not load the payment window. Check your connection."));
          document.body.appendChild(script);
        });
      }
      const rzp = new window.Razorpay!({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "Ledgerly",
        description: "Workspace subscription",
        order_id: order.id,
        handler: (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          void (async () => {
            try {
              await api("/api/billing/verify", {
                method: "POST",
                body: JSON.stringify({
                  razorpayOrderId: resp.razorpay_order_id,
                  razorpayPaymentId: resp.razorpay_payment_id,
                  razorpaySignature: resp.razorpay_signature,
                }),
              });
              toast({ title: "Payment verified", message: "Your plan is active. Thank you!", type: "success" });
              void load();
            } catch (err) {
              setError(errorMessage(err));
            }
          })();
        },
        theme: { color: "#5AA8AA" },
      });
      rzp.open();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyPlan(null);
    }
  };

  const requestManual = async (planId: string, interval: "month" | "year") => {
    setBusyPlan(planId);
    setError(null);
    try {
      const inv = await api<{ number: string; amountPaise: number }>("/api/billing/manual", {
        method: "POST",
        body: JSON.stringify({ planId, interval }),
      });
      toast({
        title: `Invoice ${inv.number} staged`,
        message: `Transfer ${rupees(inv.amountPaise)} — the plan activates once the payment reference is recorded.`,
        type: "success",
      });
      void load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyPlan(null);
    }
  };

  return (
    <section aria-label="Billing">
      <h2 className="text-h2 text-foreground">Billing</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Plans bill per workspace. Every analytics engine stays unlocked on every plan — billing never changes how your
        numbers are computed.
      </p>
      {error && <ErrorMessage title="Billing" message={error} className="mt-3" />}
      {!state ? (
        <p className="mt-4 text-sm text-muted">Loading plans…</p>
      ) : (
        <>
          <Card className="mt-4">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <CreditCard aria-hidden className="size-4 text-muted" />
              <p className="text-sm text-foreground">
                Current plan: <span className="font-semibold">{state.current?.planName ?? "Free"}</span>
              </p>
              {state.current?.currentPeriodEnd && (
                <Badge variant="outline">
                  {state.current.isTrial ? "Trial ends" : "Renews"}{" "}
                  {new Date(state.current.currentPeriodEnd).toLocaleDateString()}
                </Badge>
              )}
              <Badge variant={state.razorpayConfigured ? "success" : "outline"}>
                {state.razorpayConfigured ? "Online payments enabled" : "Offline payments only"}
              </Badge>
            </CardContent>
          </Card>
          {state.trial.active && (
            // The trial banner is the conversion surface. It is deliberately
            // honest about the deadline and about what is lost, rather than a
            // vague "your trial is ending" — a countdown nobody can act on is
            // just pressure.
            <div
              role="status"
              className={cn(
                "mt-3 rounded-lg border p-4",
                state.trial.expiringSoon ? "border-accent/50 bg-accent/8" : "border-line bg-surface",
              )}
            >
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Clock aria-hidden className="size-4 text-accent" />
                {state.trial.daysRemaining === 0
                  ? "Your Pro trial ends today"
                  : `${state.trial.daysRemaining} day${state.trial.daysRemaining === 1 ? "" : "s"} left in your Pro trial`}
              </p>
              <p className="mt-1 text-caption text-muted">
                Pro unlocks public share links, scheduled report delivery and API keys. When the trial ends your
                workspace drops to Free — your data, analyses and notebooks stay exactly as they are, and every computed
                number is unchanged. Nothing is deleted and nothing is disabled mid-analysis.
              </p>
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {state.plans.map((plan) => {
              const isCurrent = state.current?.planId === plan.id;
              // A trial is not a subscription. Hiding the purchase buttons
              // because the trial "current plan" is Pro would leave the user
              // with no way to convert at all.
              const isTrialPlan = isCurrent && state.current?.isTrial === true;
              return (
                <Card key={plan.id} className={cn(isCurrent && "border-accent/60")}>
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-h3 text-foreground">{plan.name}</h3>
                      {isTrialPlan ? (
                        <Badge variant="outline">On trial</Badge>
                      ) : (
                        isCurrent && <Badge variant="success">Current</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-caption text-muted">{plan.description}</p>
                    <p className="mt-3 flex items-center gap-1 text-lg font-bold text-foreground">
                      <IndianRupee aria-hidden className="size-4" />
                      {rupees(plan.amountPaise)}
                      <span className="text-caption font-normal text-muted">/month</span>
                    </p>
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-1.5 text-sm text-muted">
                          <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    {plan.id !== "free" && (!isCurrent || isTrialPlan) && (
                      <div className="mt-4 flex flex-col gap-2">
                        {state.razorpayConfigured && (
                          <Button
                            size="sm"
                            loading={busyPlan === plan.id}
                            onClick={() => void checkout(plan.id, "month")}
                          >
                            Subscribe online
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busyPlan === plan.id}
                          onClick={() => void requestManual(plan.id, "month")}
                        >
                          <Landmark aria-hidden className="size-4" />
                          Pay by bank transfer
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {!state.razorpayConfigured && (
            <p className="mt-3 text-caption text-muted">
              Online checkout is not configured on this deployment — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to
              enable it. Bank transfer (manual) works without any gateway.
            </p>
          )}
        </>
      )}
    </section>
  );
}
