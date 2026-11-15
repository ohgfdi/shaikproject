/**
 * Client-invoice payment contract: the exact string Razorpay signs, the
 * verification rule, and every refusal path. No network, no credentials.
 */

import { ApiError } from "@/lib/auth/guard";
import {
  checkoutSignature,
  checkoutSignaturePayload,
  razorpayAmountMinor,
  verifyCheckoutSignature,
} from "@/lib/server/practice-payments";

describe("razorpay checkout signature", () => {
  const secret = "whsec_test_secret";

  it("signs exactly order|payment", () => {
    expect(checkoutSignaturePayload("order_1", "pay_1")).toBe("order_1|pay_1");
  });

  it("is deterministic and hex-encoded", () => {
    const signature = checkoutSignature("order_1", "pay_1", secret);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(checkoutSignature("order_1", "pay_1", secret)).toBe(signature);
    // A different order or payment changes the digest.
    expect(checkoutSignature("order_2", "pay_1", secret)).not.toBe(signature);
    expect(checkoutSignature("order_1", "pay_2", secret)).not.toBe(signature);
  });

  it("accepts the signature it produced and rejects every mutation", () => {
    const signature = checkoutSignature("order_1", "pay_1", secret);
    expect(verifyCheckoutSignature("order_1", "pay_1", signature, secret)).toBe(true);
    expect(verifyCheckoutSignature("order_1", "pay_1", signature, "other_secret")).toBe(false);
    expect(verifyCheckoutSignature("order_2", "pay_1", signature, secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_2", signature, secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", signature.slice(0, -1) + "0", secret)).toBe(false);
  });

  it("never verifies with a missing secret or signature", () => {
    const signature = checkoutSignature("order_1", "pay_1", secret);
    expect(verifyCheckoutSignature("order_1", "pay_1", signature, "")).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", "", secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", "not-hex", secret)).toBe(false);
  });
});

describe("invoice amount", () => {
  it("passes through integer paise unchanged", () => {
    expect(razorpayAmountMinor(442_500)).toBe(442_500);
  });

  it("refuses zero, negative and fractional amounts rather than rounding money", () => {
    expect(() => razorpayAmountMinor(0)).toThrow(ApiError);
    expect(() => razorpayAmountMinor(-1)).toThrow(ApiError);
    expect(() => razorpayAmountMinor(10.5)).toThrow(ApiError);
  });
});
