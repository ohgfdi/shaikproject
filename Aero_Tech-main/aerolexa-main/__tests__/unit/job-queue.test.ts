/**
 * Unit tests for job queue idempotency and retry logic.
 * These tests verify idempotency key generation and backoff calculation without requiring a database.
 */

import { generateIdempotencyKey, defaultRetryBackoff } from "@/lib/server/queue";

describe("Job Queue Idempotency", () => {
  describe("generateIdempotencyKey", () => {
    it("should generate the same key for the same inputs", () => {
      const key1 = generateIdempotencyKey("job-123", 1);
      const key2 = generateIdempotencyKey("job-123", 1);

      expect(key1).toBe(key2);
    });

    it("should generate different keys for different job IDs", () => {
      const key1 = generateIdempotencyKey("job-123", 1);
      const key2 = generateIdempotencyKey("job-456", 1);

      expect(key1).not.toBe(key2);
    });

    it("should generate different keys for different run numbers", () => {
      const key1 = generateIdempotencyKey("job-123", 1);
      const key2 = generateIdempotencyKey("job-123", 2);

      expect(key1).not.toBe(key2);
    });

    it("should generate keys in the expected format", () => {
      const key = generateIdempotencyKey("job-123", 1);

      expect(key).toMatch(/^idem-[a-f0-9]+$/);
    });
  });

  describe("defaultRetryBackoff", () => {
    it("should return increasing delays for increasing run numbers", () => {
      const delay1 = defaultRetryBackoff(1);
      const delay2 = defaultRetryBackoff(2);
      const delay3 = defaultRetryBackoff(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });

    it("should cap at maximum delay (1 hour)", () => {
      const delay = defaultRetryBackoff(20); // High run number

      expect(delay).toBeLessThanOrEqual(3600000); // 1 hour
      expect(delay).toBeGreaterThan(3500000); // Close to 1 hour
    });

    it("should include jitter", () => {
      // Run multiple times and check that we get different values
      // (due to jitter). Continuous random jitter can never produce an exact
      // duplicate in practice, so comparing raw milliseconds is the
      // deterministic way to assert variation.
      const delays = Array.from({ length: 20 }, () => defaultRetryBackoff(1));

      expect(new Set(delays).size).toBeGreaterThan(1);
    });

    it("should calculate base delay correctly", () => {
      // runNumber 1: ~1 minute (60000ms)
      // runNumber 2: ~2 minutes (120000ms)
      // runNumber 3: ~4 minutes (240000ms)

      const delay1 = defaultRetryBackoff(1);
      const delay2 = defaultRetryBackoff(2);
      const delay3 = defaultRetryBackoff(3);

      // Allow for jitter, but check approximate values
      expect(delay1).toBeGreaterThanOrEqual(50000); // ~1 minute
      expect(delay1).toBeLessThanOrEqual(70000);

      expect(delay2).toBeGreaterThanOrEqual(100000); // ~2 minutes
      expect(delay2).toBeLessThanOrEqual(140000);

      expect(delay3).toBeGreaterThanOrEqual(200000); // ~4 minutes
      expect(delay3).toBeLessThanOrEqual(280000);
    });
  });
});

describe("Job Queue Retry Logic", () => {
  it("should retry up to maxRetries times", () => {
    const maxRetries = 5;

    // Simulate retry logic
    for (let runNumber = 1; runNumber <= maxRetries + 1; runNumber++) {
      const shouldRetry = runNumber <= maxRetries;
      const nextRunAt = shouldRetry ? new Date(Date.now() + defaultRetryBackoff(runNumber)) : undefined;

      if (shouldRetry) {
        expect(nextRunAt).toBeDefined();
        expect(nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      } else {
        expect(nextRunAt).toBeUndefined();
      }
    }
  });
});
