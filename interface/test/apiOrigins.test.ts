/**
 * The public API origin: where the two public legal-body reads go.
 *
 * Set, it is the API's own origin, so the browser calls the API directly and is its own caller to
 * the public limiter. Unset, it is `API_URL`, so those reads go wherever every other call goes
 * (the same-origin proxy by default). Everything authenticated keeps `API_URL` either way.
 *
 * The module reads the environment once, when it is first imported: each test stubs the variable,
 * drops the module cache and imports a fresh copy.
 */
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function freshConfig() {
  vi.resetModules();
  return import("@/lib/api/config");
}

test("set, it is the API's own origin without a trailing slash", async () => {
  vi.stubEnv("NEXT_PUBLIC_PUBLIC_API_ORIGIN", "https://api.example.test/");
  const { PUBLIC_API_ORIGIN } = await freshConfig();
  expect(PUBLIC_API_ORIGIN).toBe("https://api.example.test");
});

test("unset, it is API_URL", async () => {
  vi.stubEnv("NEXT_PUBLIC_PUBLIC_API_ORIGIN", undefined);
  vi.stubEnv("NEXT_PUBLIC_API_URL", undefined);
  const { API_URL, PUBLIC_API_ORIGIN } = await freshConfig();
  expect(PUBLIC_API_ORIGIN).toBe(API_URL);
  // With no API URL configured either, both are the same-origin proxy.
  expect(PUBLIC_API_ORIGIN).toBe("/backend");
});
