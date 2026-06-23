import { Hono } from "hono";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import { type AuthVars, requireAuth } from "../../src/auth/middleware";
import { signSession, verifySession } from "../../src/auth/session";

const SECRET = "test-secret";
const ADDR = getAddress("0x000000000000000000000000000000000000aaaa");
const NOW = Math.floor(Date.now() / 1000);

test("signSession then verifySession round-trips the tenantId", async () => {
  const { token } = await signSession(ADDR, SECRET, 3600, NOW);
  expect((await verifySession(token, SECRET)).tenantId).toBe(ADDR);
});

test("expired token is rejected", async () => {
  const { token } = await signSession(ADDR, SECRET, -10, NOW); // already expired
  await expect(verifySession(token, SECRET)).rejects.toThrow();
});

test("tampered/garbage token is rejected", async () => {
  await expect(verifySession("not.a.jwt", SECRET)).rejects.toThrow();
});

test("requireAuth sets tenantId on valid Bearer", async () => {
  const { token } = await signSession(ADDR, SECRET, 3600, NOW);
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", requireAuth(SECRET));
  app.get("/me", (c) => c.json({ tenantId: c.get("tenantId") }));
  const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect((await res.json()).tenantId).toBe(ADDR);
});

test("requireAuth throws (401-mapped) on missing token", async () => {
  const app = new Hono();
  app.use("*", requireAuth(SECRET));
  app.get("/me", (c) => c.json({ ok: true }));
  app.onError((e, c) =>
    c.json(
      { error: (e as { code?: string }).code ?? "err" },
      ((e as { status?: number }).status ?? 500) as 401,
    ),
  );
  const res = await app.request("/me");
  expect(res.status).toBe(401);
});
