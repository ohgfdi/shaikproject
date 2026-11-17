/**
 * Phase 20: Billing & Pricing
 *
 * Pricing tier display and Stripe integration for subscription management.
 * Shows feature differences between Free, Pro, and Enterprise tiers.
 */
import React from "react";
import { useState } from "react";

export type PricingTier = "free" | "pro" | "enterprise";

export type PricingTierFeatures = {
  [key in PricingTier]: {
    name: string;
    price: string;
    billing: "monthly" | "annual";
    features: string[];
    cta: string;
    ctaUrl?: string;
  };
};

export const pricingTiers: Record<PricingTier, PricingTierFeatures> = {
  free: {
    name: "Free",
    price: "Free",
    billing: "monthly",
    features: [
      "3 dashboards max",
      "Basic chart types",
      "1GB storage",
      "Email support",
      "Community forum",
    ],
    cta: "Get Started",
    ctaUrl: "/auth/signup",
  },
  pro: {
    name: "Pro",
    price: "$49",
    billing: "monthly",
    features: [
      "Unlimited dashboards",
      "Advanced chart types",
      "5GB storage",
      "PDF export",
      "Email support",
      "Priority support",
      "API access",
      "Custom branding",
    ],
    cta: "Start Free Trial",
    ctaUrl: "/billing/trial",
  },
  enterprise: {
    name: "Enterprise",
    price: "Custom",
    billing: "annual",
    features: [
      "Unlimited everything",
      "All advanced chart types",
      "Unlimited storage",
      "White-label branding",
      "Dedicated account manager",
      "SLA guarantee",
      "SSO & SAML",
      "Custom compliance",
      "On-premise option",
      "Advanced analytics",
    ],
    cta: "Contact Sales",
    ctaUrl: "/billing/contact",
  },
};

/** PricingCard - displays a pricing tier card. */
export const PricingCard: React.FC<{
  tier: PricingTier;
  highlighted?: boolean;
  onSubscribe?: (tier: PricingTier) => void;
}> = ({ tier, highlighted = false, onSubscribe }) => {
  const features = pricingTiers[tier].features;
  const { name, price, billing, cta, ctaUrl } = pricingTiers[tier];

  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <div
      className={`
        pricing-card
        ${highlighted ? "pricing-card-highlighted" : ""}
        border
        ${highlighted ? "border-primary shadow-xl" : "border-gray-200"}
      `}
    >
      <div className="pricing-header">
        <h3 className="pricing-name">{name}</h3>
        {tier !== "free" && (
          <p className="pricing-price">
            {price}/{"monthly" === billing ? "mo" : "yr"}
          </p>
        )}
      </div>

      <ul className="pricing-features">
        {features.map((feature, index) => (
          <li
            key={index}
            className="pricing-feature-item"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                d="M9 12l2 2 4-4m5.618-4.016a11.955 11.955 0 0 1 .7 2.053 11.955 11.955 0 0 1-.7 2.053C15 6.613 6 15 6 15s9 8.387 9-1.407a11.955 11.955 0 0 1-.7-2.053z"
              />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {tier === "free"
        ? (
          <button
            onClick={() => onSubscribe?.(tier)}
            className="btn btn-primary w-full"
          >
            {cta}
          </button>
        )
        : (
          <button
            onClick={() => onSubscribe?.(tier)}
            className="btn btn-primary w-full"
          >
            {cta}
          </button>
        )}

      {tier !== "free" && (
        <p className="pricing-subtext">
          {billing === "monthly" ? "Billing monthly" : "Billing annually"}
          {billing === "annual" && " (save 16%)"}
        </p>
      )}
    </div>
  );
};

/** PricingTable - displays all pricing tiers. */
export const PricingTable: React.FC<{
  onTierSelect?: (tier: PricingTier) => void;
  highlightedTier?: PricingTier;
}> = ({ onTierSelect, highlightedTier }) => {
  return (
    <div className="pricing-table">
      {(Object.keys(pricingTiers) as PricingTier[]).map((tier) => (
        <PricingCard
          key={tier}
          tier={tier as PricingTier}
          highlighted={tier === (highlightedTier || "free")}
          onSubscribe={onTierSelect}
        />
      ))}
    </div>
  );
};