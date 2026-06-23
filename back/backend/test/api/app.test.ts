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
