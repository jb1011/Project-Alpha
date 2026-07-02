import { expect, test } from "vitest";
import { SsrfError, assertPublicHttpsUrl } from "../../src/payments/ssrfGuard";

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
