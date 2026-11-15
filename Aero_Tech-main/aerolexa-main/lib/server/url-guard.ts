/**
 * Server-side fetch safety for the REST import connector.
 *
 * A user-supplied URL must never be fetched blindly: from inside a server or
 * container, addresses like 169.254.169.254 (cloud metadata), 127.0.0.1,
 * ::1, 10.x/172.16.x/192.168.x ranges or *.internal resolve to services the
 * caller must not reach with the server's network position (SSRF).
 *
 * This guard validates the literal URL (scheme, credentials, hostname shape)
 * and then resolves every DNS name it will actually connect to and checks the
 * resolved addresses — so a DNS name that points at an internal IP is caught
 * too. Redirects are followed manually (one fetch per hop, each re-validated)
 * because Node's `redirect: "follow"` would happily hop to a private target.
 *
 * Everything here fails CLOSED: an unresolvable name or an unverifiable
 * address is rejected, never fetched.
 */

import { lookup } from "node:dns/promises";
import net from "node:net";

export class UrlGuardError extends Error {
  status: number;
  code: string;

  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "UrlGuardError";
    this.status = opts.status ?? 400;
    this.code = opts.code ?? "URL_BLOCKED";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 5;

/** Block hostnames that smell like internal domains even before DNS. */
function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".svc") || // Kubernetes service names
    h.endsWith(".cluster.local")
  );
}

/** True when `ip` is a private, loopback, link-local or otherwise non-public address. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local (cloud metadata!)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (includes some metadata planes)
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped — check the embedded v4 address.
      return isPrivateIp(lower.replace("::ffff:", ""));
    }
    // Loopback-embedded forms like ::ffff:0:127.0.0.1 or ::1-equivalents.
    if (lower.includes("127.0.0.1")) return true;
    return false;
  }
  return true; // not parseable as an IP → treat as unverifiable → block
}

/**
 * Validate a literal URL and resolve every hostname it targets, checking all
 * resolved addresses. Throws `UrlGuardError` with a user-facing message when
 * the URL must not be fetched.
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlGuardError("Enter a valid http(s) endpoint URL.");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlGuardError(
      "Unsupported protocol. What happened: only http: and https: URLs are allowed for REST imports. How to fix: use a valid http(s) endpoint URL.",
    );
  }
  if (url.username || url.password) {
    throw new UrlGuardError(
      "Credentials in the URL are not supported. What happened: the URL embeds a username or password. How to fix: use the Bearer token field instead of URL credentials.",
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    throw new UrlGuardError("Enter a valid http(s) endpoint URL.");
  }
  if (isInternalHostname(hostname)) {
    throw new UrlGuardError(
      `“${hostname}” is an internal address and cannot be fetched. What happened: REST imports only reach public endpoints. How to fix: use the publicly reachable URL of the data source.`,
    );
  }

  if (net.isIP(hostname)) {
    // Literal IP — must itself be public.
    if (isPrivateIp(hostname)) {
      throw new UrlGuardError(
        `The address ${hostname} is a private/loopback address and cannot be fetched. What happened: server-side imports must not reach internal networks. How to fix: use the public endpoint URL.`,
      );
    }
    return url;
  }

  // Hostname: resolve it and verify EVERY address is public (fail closed).
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlGuardError(
      `“${hostname}” could not be resolved. What happened: the DNS name does not exist or the server cannot resolve it. How to fix: check the URL and retry.`,
      { status: 502, code: "CONNECTOR_UNREACHABLE" },
    );
  }
  if (!addresses || addresses.length === 0) {
    throw new UrlGuardError(`“${hostname}” does not resolve to any address. How to fix: check the URL and retry.`, {
      status: 502,
      code: "CONNECTOR_UNREACHABLE",
    });
  }
  const bad = addresses.find((a) => isPrivateIp(a.address));
  if (bad) {
    throw new UrlGuardError(
      `“${hostname}” resolves to a private address (${bad.address}) and cannot be fetched. What happened: the endpoint points into an internal network. How to fix: use the publicly reachable URL of the data source.`,
    );
  }
  return url;
}

/**
 * Server-side fetch of a validated external URL with SSRF-safe redirect
 * handling: every redirect hop is itself validated (and its redirect chain
 * bounded), unlike `redirect: "follow"`.
 */
export async function safeExternalFetch(
  rawUrl: string,
  init: { headers?: Record<string, string> } = {},
): Promise<Response> {
  let current = await assertSafeExternalUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual", // every hop goes through assertSafeExternalUrl
      headers: init.headers,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // 3xx without Location — treat as final
      try {
        res.body?.cancel().catch(() => undefined);
      } catch {
        // draining the body is best-effort
      }
      const next = new URL(location, current);
      if (!ALLOWED_PROTOCOLS.has(next.protocol)) {
        throw new UrlGuardError("The endpoint redirected to a non-http(s) URL, which is not allowed.", {
          status: 502,
          code: "CONNECTOR_ERROR",
        });
      }
      current = await assertSafeExternalUrl(next.toString());
      continue;
    }
    return res;
  }
  throw new UrlGuardError(
    `The endpoint redirected more than ${MAX_REDIRECTS} times. What happened: redirect loop. How to fix: use a direct URL.`,
    { status: 508, code: "CONNECTOR_ERROR" },
  );
}
