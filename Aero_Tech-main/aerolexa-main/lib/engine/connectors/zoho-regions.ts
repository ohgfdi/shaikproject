/**
 * Zoho Books data centers — the single source of truth for the connector, the
 * config schema and the settings form.
 *
 * Zoho runs separate regional clouds. A refresh token minted on one data
 * center is rejected by every other one, so the region is part of the
 * connection config and must be named exactly. Keeping the hosts here (rather
 * than duplicated in the connector and the UI) means a new data center is one
 * entry, and `satisfies Record<ZohoBooksRegion, …>` makes a missing region a
 * compile error instead of a silent India fallback.
 */

import type { ZohoBooksConfig } from "./config";

export type ZohoBooksRegion = ZohoBooksConfig["region"];

export interface ZohoRegionMeta {
  value: ZohoBooksRegion;
  /** Short name used in error messages and the connection test result. */
  name: string;
  /** Form label: name plus the host the token must be minted on. */
  label: string;
  /** One-line explanation shown under the data-center selector. */
  hint: string;
  /** OAuth host (accounts.*). */
  accountsHost: string;
  /** Books API host (www.zohoapis.*). */
  apiHost: string;
}

export const ZOHO_BOOKS_REGION_META = {
  in: {
    value: "in",
    name: "India",
    label: "India (zoho.in)",
    hint: "Indian accounts live on zoho.in. A token minted on any other Zoho data center will be rejected here.",
    accountsHost: "accounts.zoho.in",
    apiHost: "www.zohoapis.in",
  },
  us: {
    value: "us",
    name: "US",
    label: "US (zoho.com)",
    hint: "US and global accounts live on zoho.com.",
    accountsHost: "accounts.zoho.com",
    apiHost: "www.zohoapis.com",
  },
  eu: {
    value: "eu",
    name: "Europe",
    label: "Europe (zoho.eu)",
    hint: "European data-center accounts live on zoho.eu.",
    accountsHost: "accounts.zoho.eu",
    apiHost: "www.zohoapis.eu",
  },
  au: {
    value: "au",
    name: "Australia",
    label: "Australia (zoho.com.au)",
    hint: "Australian accounts live on zoho.com.au.",
    accountsHost: "accounts.zoho.com.au",
    apiHost: "www.zohoapis.com.au",
  },
  jp: {
    value: "jp",
    name: "Japan",
    label: "Japan (zoho.jp)",
    hint: "Japanese accounts live on zoho.jp.",
    accountsHost: "accounts.zoho.jp",
    apiHost: "www.zohoapis.jp",
  },
  ca: {
    value: "ca",
    name: "Canada",
    label: "Canada (zohocloud.ca)",
    hint: "Canadian accounts live on zohocloud.ca.",
    accountsHost: "accounts.zohocloud.ca",
    apiHost: "www.zohoapis.ca",
  },
  sa: {
    value: "sa",
    name: "Saudi Arabia",
    label: "Saudi Arabia (zohosa.com)",
    hint: "Saudi accounts live on zohosa.com.",
    accountsHost: "accounts.zohosa.com",
    apiHost: "www.zohoapis.sa.com",
  },
  cn: {
    value: "cn",
    name: "China",
    label: "China (zoho.com.cn)",
    hint: "Chinese accounts live on zoho.com.cn.",
    accountsHost: "accounts.zoho.com.cn",
    apiHost: "www.zohoapis.com.cn",
  },
} satisfies Record<ZohoBooksRegion, ZohoRegionMeta>;

/** The eight data centers in form order (India first: this product's wedge). */
export const ZOHO_BOOKS_REGIONS: readonly ZohoRegionMeta[] = [
  ZOHO_BOOKS_REGION_META.in,
  ZOHO_BOOKS_REGION_META.us,
  ZOHO_BOOKS_REGION_META.eu,
  ZOHO_BOOKS_REGION_META.au,
  ZOHO_BOOKS_REGION_META.jp,
  ZOHO_BOOKS_REGION_META.ca,
  ZOHO_BOOKS_REGION_META.sa,
  ZOHO_BOOKS_REGION_META.cn,
];

/** Look up a data center without throwing (the UI uses this for hints). */
export function zohoRegionMeta(region: string): ZohoRegionMeta | undefined {
  return ZOHO_BOOKS_REGIONS.find((entry) => entry.value === region);
}
