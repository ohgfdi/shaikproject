/**
 * Phase 10: Rate Limit Types
 *
 * Enum of preset rate limits for common use cases.
 * Used by the rate-limit middleware to configure per-endpoint limits.
 */
export enum RATE_LIMITS {
  /** 10 login attempts per 15 minutes per IP */
  login = 10,

  /** 200 API requests per 15 minutes per IP */
  api = 200,

  /** 20 burst requests per 1 minute (for short bursts) */
  burst = 20,

  /** 100 dashboard requests per 15 minutes per IP */
  dashboard = 100,

  /** 50 report export requests per 15 minutes per IP */
  reportExport = 50,
}