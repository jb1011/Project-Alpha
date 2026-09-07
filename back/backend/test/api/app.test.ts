import { expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { ApiError } from "../../src/api/errors";

const deps = { webOrigin: "*" } as never;

test("GET /healthz returns ok", async () => {
  const res = await buildApiApp(deps).request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("apiOnError maps ApiError to its status + envelope", async () => {
  const app = buildApiApp(deps);
  app.get("/boom", () => {
    throw new ApiError("not_found", 404, "nope", { id: "x" });
  });
  const res = await app.request("/boom");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({
    error: { code: "not_found", message: "nope", details: { id: "x" } },
  });
});

test("unknown error maps to 500 envelope", async () => {
  const app = buildApiApp(deps);
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  const res = await app.request("/boom");
  expect(res.status).toBe(500);
  expect((await res.json()).error.code).toBe("internal_error");
});

/**
 * EVERY PROTECTED PREFIX IS PROTECTED ON BOTH SHAPES.
 *
 * Hono's `use` on a bare path matches THAT PATH ONLY, so `/companies` and `/companies/*` are two
 * separate registrations — and the hand-written list had already drifted, which is how
 * `PATCH /companies/:companyId` (the second door that can carry an SSN) shipped with no auth and
 * no tenant to scope it by. `protect()` registers both; this asserts it for every prefix, so the
 * next one added cannot be half-registered.
 */
const PROTECTED = [
  "/onboard",
  "/formation-party",
  "/companies",
  "/entities",
  "/jobs",
  "/api-keys",
  "/connection-package",
  "/bootstrap-connection",
];

test("no protected prefix answers without a token — bare path or subpath", async () => {
  const app = buildApiApp(deps);
  for (const prefix of PROTECTED)
    for (const path of [prefix, `${prefix}/anything`, `${prefix}/a/b`]) {
      // GET and a mutating verb, because a prefix can carry either and the middleware is what
      // decides — not the individual route.
      for (const method of ["GET", "POST", "PATCH"]) {
        const res = await app.request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
});

test("the public routes are still public — the helper did not over-reach", async () => {
  const app = buildApiApp(deps);
  for (const path of ["/healthz", "/config", "/auth/nonce", "/schema/agent-spec.json"])
    expect((await app.request(path)).status, path).not.toBe(401);
});
