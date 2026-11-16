import type { AuthOptions } from "next-auth";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers-azure-ad";
import OIDCProvider from "next-auth/providers/oidc";
import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { stringifyJson } from "@/lib/json";
import { logSecurityEvent } from "@/lib/server/activity";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/types";

/** Resolve or create a user from a SSO provider email. */
async function resolveSsoUser(email: string, name?: string | null) {
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email: normalized },
    include: { workspace: true },
  });
  if (existing) return existing;

  const displayName = name?.trim() || normalized.split("@")[0] || "SSO user";
  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
  return prisma.user.create({
    data: {
      name: displayName,
      email: normalized,
      passwordHash, // unguessable; verifyPassword will never match
      emailVerifiedAt: new Date(),
      workspace: {
        create: {
          name: `${displayName.split(" ")[0] || "Your"}'s workspace`,
          settings: stringifyJson({ ...DEFAULT_WORKSPACE_SETTINGS }),
        },
      },
    },
    include: { workspace: true },
  });
}

/** Env checks. */
const env = serverEnv();
const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const azureConfigured = Boolean(
  env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.TENANT_ID,
);
const oidcConfigured = Boolean(env.OIDC_ISSUER_URL);

/** NextAuth provider list — only appear when configured + SSO_ENABLED. */
const buildProviders = (): any[] => {
  if (!env.SSO_ENABLED) return [Credentials];

  const providers: any[] = [];
  if (googleConfigured) providers.push(GoogleProvider({}));
  if (azureConfigured) providers.push(AzureADProvider({}));
  if (oidcConfigured) providers.push(
    OIDCProvider({
      issuer: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
    }),
  );

  // If no third‑party provider is configured, fall back to credentials
  if (providers.length === 0) return [Credentials];

  return providers;
};

const authOptions: AuthOptions = {
  providers: buildProviders(),

  secret: env.NEXTAUTH_SECRET || env.AUTH_SECRET,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (account && user?.email) {
        const dbUser = await resolveSsoUser(user.email, user.name);
        token.sub = dbUser.id;
        token.email = dbUser.email;
        token.name = dbUser.name;
        if (dbUser.workspace) {
          await logSecurityEvent(
            dbUser.workspace.id,
            dbUser.id,
            "SECURITY_SSO",
            `${dbUser.email} signed in with ${account.provider}`,
          );
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email ?? session.user.email;
        session.user.name = token.name ?? session.user.name;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };