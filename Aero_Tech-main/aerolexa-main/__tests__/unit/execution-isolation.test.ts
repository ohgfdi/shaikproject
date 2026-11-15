/**
 * Unit tests for execution sandbox validation.
 * These tests verify resource limit validation without requiring a database.
 */

import { validateSandboxConfig } from "@/lib/server/execution/sandbox";

describe("Execution Sandbox Validation", () => {
  describe("validateSandboxConfig", () => {
    it("should accept valid configuration within bounds", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 512 * 1024 * 1024, // 512MB
        cpuLimitMs: 100,
        wallClockTimeoutMs: 300000, // 5 minutes
      };

      expect(() => validateSandboxConfig(config)).not.toThrow();
    });

    it("should reject memory limit above maximum (8GB)", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 16 * 1024 * 1024 * 1024, // 16GB (exceeds 8GB max)
        cpuLimitMs: 100,
        wallClockTimeoutMs: 300000,
      };

      expect(() => validateSandboxConfig(config)).toThrow(/Memory limit .* exceeds the maximum/);
    });

    it("should reject memory limit below minimum (64MB)", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 32 * 1024 * 1024, // 32MB (below 64MB min)
        cpuLimitMs: 100,
        wallClockTimeoutMs: 300000,
      };

      expect(() => validateSandboxConfig(config)).toThrow(/Memory limit .* is below the minimum/);
    });

    it("should reject CPU limit above maximum (4 cores)", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 512 * 1024 * 1024,
        cpuLimitMs: 500, // 5 CPU cores (exceeds 4 core max)
        wallClockTimeoutMs: 300000,
      };

      expect(() => validateSandboxConfig(config)).toThrow(/CPU limit .* exceeds the maximum/);
    });

    it("should reject timeout above maximum (1 hour)", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 512 * 1024 * 1024,
        cpuLimitMs: 100,
        wallClockTimeoutMs: 7200000, // 2 hours (exceeds 1 hour max)
      };

      expect(() => validateSandboxConfig(config)).toThrow(/Timeout .* exceeds the maximum/);
    });

    it("should reject timeout below minimum (1 second)", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        memoryLimitBytes: 512 * 1024 * 1024,
        cpuLimitMs: 100,
        wallClockTimeoutMs: 500, // 0.5 seconds (below 1 second min)
      };

      expect(() => validateSandboxConfig(config)).toThrow(/Timeout .* is below the minimum/);
    });

    it("should use defaults when config values are not provided", () => {
      const config = {
        organizationId: "org-123",
        sandboxType: "container" as const,
        // No optional fields - should use defaults
      };

      expect(() => validateSandboxConfig(config)).not.toThrow();
    });
  });
});
