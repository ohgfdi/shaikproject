/**
 * Phase 11: Email Verification Service
 *
 * Sends email verification on user signup and supports resend.
 * Uses the existing MailOutbox model for durable queueing.
 *
 * Usage:
 *   import { sendVerificationEmail, resendVerificationEmail } from "@/lib/auth/verification";
 *
 *   await sendVerificationEmail(userId, userEmail);
 *   await resendVerificationEmail(userId, userEmail);
 */
import { prisma } from "@/lib/db";

/** Send a verification email to a user. */
export async function sendVerificationEmail(userId: string, email: string) {
  // Check if already verified
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });

  if (existingUser?.emailVerifiedAt) {
    // Already verified, nothing to do
    return { alreadyVerified: true, sent: false };
  }

  // Generate a verification token (in production, use a proper token service)
  const token = Buffer.from(`${userId}:${Date.now()}`).toString("base64");

  // Create mail outbox entry for durable delivery
  await prisma.mailOutbox.create({
    data: {
      toAddress: email,
      subject: "Verify your Ledgerly account",
      body: `
        <h1>Welcome to Ledgerly!</h1>
        <p>Thank you for registering! Please verify your email address by clicking the link below:</p>
        <br />
        <a href="${process.env.NEXT_PUBLIC_APP_URL}/auth/verify-email?token=${token}"
           style="background: #0052cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
          Verify Email
        </a>
        <br />
        <br />
        <p>This link will expire in 24 hours.</p>
        <br />
        <p>If you did not create an account, you can safely ignore this email.</p>
      `,
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
    },
  });

  return { alreadyVerified: false, sent: true };
}

/** Resend a verification email. */
export async function resendVerificationEmail(userId: string, email: string) {
  // Similar to sendVerificationEmail but always creates a new entry
  return await sendVerificationEmail(userId, email);
}

/** Mark user as verified (called when token is validated). */
export async function markUserVerified(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  });

  return { verified: true };
}