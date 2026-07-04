import { Hono } from "hono";
import { expect, test } from "vitest";
import { buildX402DemoDeps, mountX402DemoRoutes } from "../../src/api/routes/x402Demo";
import type { Config } from "../../src/config/env";

const DEPS = {
  payTo: "0x00000000000000000000000000000000000000ab",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  price: 10000n,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  resourceUrl: "https://example.test/backend/x402-demo/quote",
} as const;

test("no X-PAYMENT -> 402 with well-formed Arc requirements", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote");
  expect(res.status).toBe(402);
  const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
  expect(body.accepts[0]).toMatchObject({
    network: "eip155:5042002",
    asset: DEPS.asset,
    payTo: DEPS.payTo,
    maxAmountRequired: "10000",
  });
});

test("malformed X-PAYMENT -> 402 malformed", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote", { headers: { "X-PAYMENT": "not-valid!!" } });
  expect(res.status).toBe(402);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("malformed X-PAYMENT");
});

test("buildX402DemoDeps returns undefined when the flag is off", () => {
  const cfg = { enableX402Demo: false } as unknown as Config;
  expect(buildX402DemoDeps(cfg)).toBeUndefined();
});

test("buildX402DemoDeps builds Arc deps from config when on", () => {
  const cfg = {
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
  } as unknown as Config;
  const deps = buildX402DemoDeps(cfg);
  expect(deps).toBeDefined();
  expect(deps?.price).toBe(10000n);
  expect(deps?.network).toBe("eip155:5042002");
  expect(deps?.resourceUrl).toBe("https://example.test/backend/x402-demo/quote");
});
