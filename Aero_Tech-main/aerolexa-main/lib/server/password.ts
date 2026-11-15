/**
 * Password hashing and validation utilities.
 */

import { hash, compare } from "bcryptjs";

const SALT_ROUNDS = 12;

/**
 * Hash a password using bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return compare(password, hash);
}

/**
 * Validate password strength.
 * Returns { ok: boolean, message?: string }
 */
export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < 8) {
    return { ok: false, message: "Password must be at least 8 characters." };
  }

  // Check for at least one uppercase letter
  if (!/[A-Z]/.test(password)) {
    return { ok: false, message: "Password must contain at least one uppercase letter." };
  }

  // Check for at least one lowercase letter
  if (!/[a-z]/.test(password)) {
    return { ok: false, message: "Password must contain at least one lowercase letter." };
  }

  // Check for at least one digit
  if (!/\d/.test(password)) {
    return { ok: false, message: "Password must contain at least one number." };
  }

  // Check for at least one special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { ok: false, message: "Password must contain at least one special character." };
  }

  // Check for common patterns (basic check)
  const commonPasswords = ["password", "12345678", "qwerty123", "letmein123"];
  if (commonPasswords.includes(password.toLowerCase())) {
    return { ok: false, message: "Password is too common. Please choose a stronger password." };
  }

  return { ok: true };
}
