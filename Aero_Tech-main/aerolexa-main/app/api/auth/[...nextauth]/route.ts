import type { AuthOptions } from "next-auth";
import NextAuth from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import Credentials from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { randomBytes } from "node:crypto";

import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { stringifyJson } from "@/lib/json";
import { logSecurityEvent } from "@/lib/server/activity";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/types";

/**
 * Generic OpenID Connect provider. next-auth v4 has no `providers/oidc` module,
 * so the provider object is declared here and discovery is delegated to
 * next-auth via `wellKnown`.
 */
function oidcProvider(options: {
  issuer: string;
  clientId?: string;
  clientSecret?: string;
}): any {
  return {
    id: "oidc",
    name: "Single sign-on",
    type: "oauth",
    wellKnown: `${options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    authorization: { params: { scope: "openid email profile" } },
    idToken: true,
    checks: ["pkce", "state"],
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile(profile: Record<string, unknown>) {
      return {
        id: String(profile.sub ?? ""),
        name: typeof profile.name === "string" ? profile.name : null,
        email: typeof profile.email === "string" ? profile.email : null,
        image: typeof profile.picture === "string" ? profile.picture : null,
      };
    },
  };
}

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

/**
 * The environment is read when the handler is first invoked, never at module
 * load: `next build` imports every route to collect page data on a host that
 * carries no production secrets, so calling `serverEnv()` here would abort the
 * build before it can emit anything (see lib/build-phase.ts).
 */

/** NextAuth provider list — only appear when configured + SSO_ENABLED. */
const buildProviders = (env: ReturnType<typeof serverEnv>): any[] => {
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const azureConfigured = Boolean(
    env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.TENANT_ID,
  );
  const oidcConfigured = Boolean(env.OIDC_ISSUER_URL);
  if (!env.SSO_ENABLED) return [Credentials];

  const providers: any[] = [];
  if (googleConfigured) {
    providers.push(
      GoogleProvider({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
      }),
    );
  }
  if (azureConfigured) {
    providers.push(
      AzureADProvider({
        clientId: env.AZURE_CLIENT_ID!,
        clientSecret: env.AZURE_CLIENT_SECRET!,
        tenantId: env.TENANT_ID!,
      }),
    );
  }
  if (oidcConfigured) {
    providers.push(
      oidcProvider({
        issuer: env.OIDC_ISSUER_URL!,
        clientId: env.OIDC_CLIENT_ID,
        clientSecret: env.OIDC_CLIENT_SECRET,
      }),
    );
  }

  // If no third‑party provider is configured, fall back to credentials
  if (providers.length === 0) return [Credentials];

  return providers;
};

function getAuthOptions(): AuthOptions {
  const env = serverEnv();

  return {
  providers: buildProviders(env),

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
}

let cachedHandler: ReturnType<typeof NextAuth> | null = null;

function handlerFor() {
  if (!cachedHandler) cachedHandler = NextAuth(getAuthOptions());
  return cachedHandler;
}

export async function GET(request: Request, context: unknown) {
  const handler = handlerFor() as unknown as (
    request: Request,
    context: unknown,
  ) => Promise<Response>;
  return handler(request, context);
}

export const POST = GET;
