import { expect, test } from "vitest";
import { SsrfError, assertPublicHttpsUrl, isBlockedIp } from "../../src/payments/ssrfGuard";

test("accepts a public https URL", () => {
  expect(assertPublicHttpsUrl("https://api.example.com/x").hostname).toBe("api.example.com");
});
test("rejects non-https", () => {
  expect(() => assertPublicHttpsUrl("http://api.example.com")).toThrow(SsrfError);
});
test("rejects loopback / private / link-local / metadata literals", () => {
  for (const u of [
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://0.0.0.0/x",
  ])
    expect(() => assertPublicHttpsUrl(u), u).toThrow(SsrfError);
});
test("rejects a malformed URL", () => {
  expect(() => assertPublicHttpsUrl("not a url")).toThrow(SsrfError);
});

test("rejects IPv4-mapped IPv6 bypasses of blocked IPv4 ranges", () => {
  for (const u of [
    "https://[::ffff:169.254.169.254]/x", // cloud metadata
    "https://[::ffff:127.0.0.1]/x", // loopback
    "https://[::ffff:10.0.0.5]/x", // private
  ])
    expect(() => assertPublicHttpsUrl(u), u).toThrow(SsrfError);
});

test("rejects the full fe80::/10 link-local range, not just fe80 literal", () => {
  for (const u of ["https://[fe90::1]/x", "https://[fea0::1]/x", "https://[febf:ffff::1]/x"])
    expect(() => assertPublicHttpsUrl(u), u).toThrow(SsrfError);
});

test("still accepts public IPv4/IPv6 literals and hostnames", () => {
  expect(assertPublicHttpsUrl("https://[2606:4700::1111]/x").hostname).toBe("[2606:4700::1111]");
  expect(assertPublicHttpsUrl("https://8.8.8.8/x").hostname).toBe("8.8.8.8");
  expect(assertPublicHttpsUrl("https://172.32.0.1/x").hostname).toBe("172.32.0.1"); // outside 172.16/12 private block
  expect(assertPublicHttpsUrl("https://api.example.com/x").hostname).toBe("api.example.com");
});

test("isBlockedIp directly rejects the previously-bypassing literals", () => {
  for (const ip of [
    "::ffff:169.254.169.254",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.5",
    "fe90::1",
    "fea0::1",
    "febf:ffff::1",
  ])
    expect(isBlockedIp(ip), ip).toBe(true);
});

test("isBlockedIp still allows public IPv4/IPv6 literals", () => {
  for (const ip of ["2606:4700::1111", "8.8.8.8", "172.32.0.1"])
    expect(isBlockedIp(ip), ip).toBe(false);
});

test("isBlockedIp returns false for non-IP strings", () => {
  expect(isBlockedIp("api.example.com")).toBe(false);
  expect(isBlockedIp("not an ip")).toBe(false);
});
