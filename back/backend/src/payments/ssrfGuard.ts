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
  // 20s (was 10s — P3 leg-3 catch): the circle custody path signs through Circle's API (~1-2s
  // across the AgentKit + x402 signatures) on top of a seller that settles SYNCHRONOUSLY via the
  // facilitator before answering, plus serverless cold starts. 10s aborted a real, otherwise
  // healthy prod payment; the timeout exists to bound SSRF slow-loris, not to race settlement.
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(u.toString(), { ...init, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new SsrfError("redirects are not allowed");
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * A `typeof fetch` that accepts what real callers actually send — string, URL, or a full
 * `Request` object — and funnels ALL of them through `safeFetch`'s SSRF boundary.
 *
 * WHY: the AgentKit client retries an agentkit-enabled 402 with a `Request` OBJECT. The old
 * default pay fetch did `u as string`, which stringifies a Request into the literal
 * "[object Request]" and refuses it — breaking every production `pay` against an
 * agentkit-enabled seller since the World wiring (caught live by the #65 checklist,
 * 2026-08-01; the test harness handled Request itself, masking the prod seam).
 *
 * Header layering matches the Fetch spec's practical expectation: the Request's own headers
 * are the base, an explicit `init.headers` overrides per key (so a retry's fresh X-PAYMENT
 * beats a stale one, and the signed `agentkit` header survives the unwrap). Bodies are not
 * carried (x402 discovery/retry is GET-shaped); extend deliberately if a POST resource ever
 * needs it.
 */
/** Duck-typed: the AgentKit SDK constructs its Request from its OWN fetch implementation, so
 *  `instanceof Request` is FALSE cross-realm even though the object walks and quacks like one
 *  (proven live 2026-08-01: the instanceof-only fix deployed and the error persisted). URL
 *  instances also have a string `href`, not `url`, so they fall through to the string branch. */
function isRequestLike(x: RequestInfo | URL): x is Request {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Request).url === "string" &&
    typeof (x as Request).method === "string" &&
    (x as Request).headers != null
  );
}

export function requestAwareSafeFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (isRequestLike(input)) {
      const headers = new Headers(input.headers);
      new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
      return safeFetch(fetchImpl, input.url, {
        ...init,
        method: init?.method ?? input.method,
        headers,
      });
    }
    return safeFetch(fetchImpl, String(input), init);
  }) as typeof fetch;
}
