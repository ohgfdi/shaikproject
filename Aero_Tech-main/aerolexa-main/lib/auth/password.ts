import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Password policy for the prototype: ≥ 8 chars with a letter and a number.
 * OWASP 2024 guidance favours length over composition rules; this is a mild
 * middle ground tuned for demo UX (visible, actionable rules).
 */
export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < 8) return { ok: false, message: "Use at least 8 characters." };
  if (!/[A-Za-z]/.test(password)) return { ok: false, message: "Include at least one letter." };
  if (!/[0-9]/.test(password)) return { ok: false, message: "Include at least one number." };
  return { ok: true };
}
