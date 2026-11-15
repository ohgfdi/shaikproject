import { redirect } from "next/navigation";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { getAuth } from "@/lib/auth/guard";

export const metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const ctx = await getAuth();
  if (!ctx) redirect("/login");
  if (ctx.user.onboardedAt) redirect("/dashboard");
  return <OnboardingWizard name={ctx.user.name} />;
}
