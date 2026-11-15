/**
 * GST notice vocabulary, kept free of server imports so both the repository
 * (which validates against it) and the notices screen (which renders the
 * selects) use one list. Importing the server repository from a client
 * component would drag Prisma into the browser bundle.
 */

import type { AuthorityLevel, NoticeStatus, NoticeType } from "@/lib/engine/gst-notice-workflow";

export const NOTICE_TYPES: readonly NoticeType[] = [
  "asmt-10",
  "asmt-14",
  "drc-01",
  "drc-03",
  "cmp-08",
  "cmp-09",
  "adt-01",
  "adt-02",
  "rfd-01",
  "reg-17",
  "anti-profiteering",
  "e-way-bill",
  "gstr-2b-mismatch",
  "gstr-1-3b-mismatch",
  "itc-reversal",
  "other",
];

export const NOTICE_STATUSES: readonly NoticeStatus[] = [
  "received",
  "under-review",
  "response-drafting",
  "response-filed",
  "personal-hearing",
  "order-received",
  "appeal-filed",
  "closed",
  "escalated",
];

export const AUTHORITY_LEVELS: readonly AuthorityLevel[] = [
  "proper-officer",
  "jc",
  "ac",
  "dc",
  "commissioner",
  "aat",
  "high-court",
  "supreme-court",
];

export const NOTICE_PRIORITIES = ["low", "medium", "high", "critical"] as const;
