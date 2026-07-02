import { expect, test, vi } from "vitest";
import { buyWithX402 } from "../../src/payments/buyer";

const requirements = {
  payTo: "0x00000000000000000000000000000000000000ab",
  maxAmountRequired: "100",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  maxTimeoutSeconds: 60,
};

function fakeFetch(seenHeaders: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    seenHeaders.push(xp);
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
}

test("on 402, authorizes then retries with X-PAYMENT and returns the body", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok" }));
  const res = await buyWithX402(
    { fetchImpl: fakeFetch(seen), authorize },
    "https://seller/api/insight",
  );
  expect(await res.json()).toEqual({ data: "the insight" });
  expect(seen).toEqual(["X-PAYMENT-ok"]);
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ payee: requirements.payTo, amount: 100n }),
  );
});

test("a policy-denied authorization does not retry and surfaces the denial", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: false as const, reason: "over-cap" }));
  await expect(
    buyWithX402({ fetchImpl: fakeFetch(seen), authorize }, "https://seller/api/insight"),
  ).rejects.toThrow(/policy-denied: over-cap/);
  expect(seen).toEqual([]);
});

test("onAuthorized fires exactly once, after authorize ok and before the X-PAYMENT retry fetch", async () => {
  const seen: string[] = [];
  const order: string[] = [];
  const authorize = vi.fn(async () => {
    order.push("authorize");
    return { ok: true as const, header: "X-PAYMENT-ok" };
  });
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    order.push("retry-fetch");
    seen.push(xp);
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
  const onAuthorized = vi.fn(() => order.push("onAuthorized"));

  await buyWithX402(
    { fetchImpl: fetchImpl as unknown as typeof fetch, authorize, onAuthorized },
    "https://seller/api/insight",
  );

  expect(onAuthorized).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["authorize", "onAuthorized", "retry-fetch"]);
});

test("onAuthorized is never called on a policy-denied authorization", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: false as const, reason: "over-cap" }));
  const onAuthorized = vi.fn();
  await expect(
    buyWithX402(
      { fetchImpl: fakeFetch(seen), authorize, onAuthorized },
      "https://seller/api/insight",
    ),
  ).rejects.toThrow(/policy-denied: over-cap/);
  expect(onAuthorized).not.toHaveBeenCalled();
});

test("surprise-price ceiling: maxAmountRequired above maxAmount is denied before authorize is ever called", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok" }));
  const onAuthorized = vi.fn();
  await expect(
    buyWithX402(
      { fetchImpl: fakeFetch(seen), authorize, maxAmount: 99n, onAuthorized },
      "https://seller/api/insight",
    ),
  ).rejects.toThrow(/policy-denied: amount-exceeds-declared/);
  expect(authorize).not.toHaveBeenCalled();
  expect(onAuthorized).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
});

test("maxAmount at or under the ceiling proceeds normally", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok" }));
  const res = await buyWithX402(
    { fetchImpl: fakeFetch(seen), authorize, maxAmount: 100n },
    "https://seller/api/insight",
  );
  expect(res.status).toBe(200);
  expect(seen).toEqual(["X-PAYMENT-ok"]);
});
