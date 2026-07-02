import { lookup } from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

// ipaddr.js range() classifications that must never be a payment target. Using the library's range
// tables (instead of hand-rolled prefix checks) closes bypasses like IPv4-mapped IPv6 literals
// (::ffff:169.254.169.254) and partial fe80::/10 matching that a startsWith() check misses.
const BLOCKED_IPV4_RANGES = new Set([
  "unspecified",
  "broadcast",
  "private",
  "loopback",
  "linkLocal", // includes the 169.254.169.254 cloud metadata address
  "carrierGradeNat",
  "reserved",
]);

const BLOCKED_IPV6_RANGES = new Set([
  "unspecified",
  "linkLocal",
  "multicast",
  "loopback",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
  "reserved",
  "deprecatedSiteLocal", // fec0::/10 (RFC 3879) — deprecated but never a valid payment target
  "discard", // 0100::/64 (RFC 6666) blackhole prefix
  // "unicast" (globally routable) is intentionally NOT blocked — that's public internet.
]);

/** True for IPv4/IPv6 literals that must never be a payment target (loopback, private, link-local,
 *  unspecified, unique-local, IPv4-mapped IPv6, and the cloud metadata address). Delegates
 *  classification to ipaddr.js rather than hand-rolled prefix checks. */
export function isBlockedIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false; // not an IP literal
  let addr: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(ip);
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d) to plain IPv4 so the IPv4 rules apply to it too —
  // otherwise every IPv4 block (including cloud metadata) is bypassable via IPv6 syntax.
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return addr instanceof ipaddr.IPv4
    ? BLOCKED_IPV4_RANGES.has(addr.range())
    : BLOCKED_IPV6_RANGES.has(addr.range());
}

/** Parse + validate a payment URL: https only, host must not be a blocked IP literal. Hostnames are
 *  additionally re-checked against their resolved IP at fetch time (see safeFetch). Throws SsrfError. */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError(`invalid url: ${raw}`);
  }
  if (u.protocol !== "https:") throw new SsrfError(`must be https: ${raw}`);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost") throw new SsrfError("localhost blocked");
  if (net.isIP(host) && isBlockedIp(host)) throw new SsrfError(`blocked ip: ${host}`);
  return u;
}

/** Fetch with SSRF hardening: validate the URL, resolve the host and reject blocked IPs, forbid redirects
 *  (redirect:"manual" — an x402 resource must answer directly), and enforce a timeout. */
export async function safeFetch(
  fetchImpl: typeof fetch,
  raw: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  const u = assertPublicHttpsUrl(raw);
  if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
    // Resolve ALL addresses the hostname maps to (A + AAAA) and reject if ANY is blocked — a hostname
    // that round-robins or rotates between a public and a blocked IP (DNS rebinding) must not sneak a
    // blocked address through just because the first resolved record looked public.
    const addrs = await lookup(u.hostname, { all: true });
    const blocked = addrs.find((a) => isBlockedIp(a.address));
    if (blocked) throw new SsrfError(`host ${u.hostname} resolves to blocked ${blocked.address}`);
  }
  // Residual TOCTOU (v1 limitation, documented — not fixed here): fetchImpl() below re-resolves the
  // hostname itself at connect time, after the check above. A DNS answer that changes between our
  // lookup() and the underlying fetch's own resolution (classic DNS rebinding) can still slip a
  // blocked IP through. Fully closing this requires pinning the TCP connection to the specific IP we
  // validated here, e.g. via a custom undici Agent/dispatcher that skips fetch's own DNS resolution.
  // Fast-follow, not done now — see BYOA P2b Task 6 for where safeFetch's network path is exercised.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(u.toString(), { ...init, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new SsrfError("redirects are not allowed");
    return res;
  } finally {
    clearTimeout(t);
  }
}
