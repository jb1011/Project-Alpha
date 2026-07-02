import { lookup } from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {}

/** True for IPv4/IPv6 literals that must never be a payment target (loopback, private, link-local,
 *  unspecified, unique-local, and the cloud metadata address). */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    // net.isIP(ip) === 4 guarantees exactly 4 numeric dotted-decimal octets.
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / unspecified
    if (a === 169 && b === 254) return true; // link-local + metadata (169.254.169.254)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase();
    return (
      lo === "::1" ||
      lo === "::" ||
      lo.startsWith("fc") ||
      lo.startsWith("fd") ||
      lo.startsWith("fe80")
    );
  }
  return false; // not an IP literal
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
    const { address } = await lookup(u.hostname); // resolve hostname → reject if it maps to a blocked IP
    if (isBlockedIp(address))
      throw new SsrfError(`host ${u.hostname} resolves to blocked ${address}`);
  }
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
