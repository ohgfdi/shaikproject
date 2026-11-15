import type { AuthOptions } from "next-auth";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { stringifyJson } from "@/lib/json";
import { logSecurityEvent } from "@/lib/server/activity";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/types";

/**
 * Bridge a provider identity onto Ledgerly's `User` table.
 *
 * Accounts are keyed by email — the same key email+password sign-in uses — so
 * the first SSO sign-in provisions a workspace + user exactly like
 * `registerUser` does, and every later sign-in (SSO or password) resolves to
 * that same row. SSO users never chose a password, but `User.passwordHash` is
 * required, so we store an unguessable random bcrypt hash that `verifyPassword`
 * can never match.
 */
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
      passwordHash,
      // The provider has already verified ownership of this address.
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

const env = serverEnv();
const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const authOptions: AuthOptions = {
  // Google is the only provider wired so far; additional OIDC/SAML providers
  // plug in here. The provider list stays empty unless SSO is enabled AND
  // credentials are present, so the endpoints never offer a dead button.
  providers:
    env.SSO_ENABLED && googleConfigured
      ? [
          GoogleProvider({
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : [
          // Email/password provider for client onboarding
          // Credentials are validated against the stored password hash
          Credentials({
            async authorize(credentials) {
              const normalizedEmail = credentials?.email?.trim().toLowerCase();
              const user = await prisma.user.findUnique({
                where: { email: normalizedEmail },
              });

              if (!user || !user.passwordHash) {
                return null; // No user found or password not set (SSO only)
              }

              const passwordValid = await verifyPassword(
                credentials?.password ?? "",
                user.passwordHash
              );

              if (!passwordValid) {
                return null; // Invalid password
              }

              // Return the user object to create a session
              return { id: user.id, email: user.email, name: user.name };
            },
            credentials: {
              email: { label: "Email", type: "email", placeholder: "you@company.com" },
              password: { label: "Password", type: "password" },
            },
          }),
        ],
  secret: env.NEXTAUTH_SECRET || env.AUTH_SECRET,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async jwt({ token, user, account }) {
      // `user`/`account` are only present on the initial sign-in, so the
      // account lookup and audit entry happen once per login rather than on
      // every session read.
      if (account && user?.email) {
        const dbUser = await resolveSsoUser(user.email, user.name);
        // Point the NextAuth JWT at the Ledgerly user id so `readSession()`
        // resolves the same account as email+password sign-in.
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

// App Router: NextAuth returns a single (req) => Response handler that must be
// exported for both methods. Calling it inside a wrapper (the previous shape)
// returned a function to the runtime and every auth request 500'd.
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
