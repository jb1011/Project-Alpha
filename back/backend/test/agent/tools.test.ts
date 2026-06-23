import { expect, test, vi } from "vitest";
import { type AgentToolDeps, makeTools } from "../../src/agent/tools";

const accept = {
  payTo: "0x00000000000000000000000000000000000000cd",
  maxAmountRequired: "10000",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  maxTimeoutSeconds: 600,
};

function fetchImpl(served: unknown) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    return xp
      ? new Response(JSON.stringify(served), { status: 200 })
      : new Response(JSON.stringify({ accepts: [accept] }), { status: 402 });
  }) as unknown as typeof fetch;
}

function deps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    fetchImpl: fetchImpl({ body: { index: 0.62 } }),
    authorize: async () => ({ ok: true, header: "X-PAYMENT-ok" }),
    vendorBase: "http://vendor.local",
    readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }),
    ...over,
  };
}

test("getBudget returns available minus runningPending", async () => {
  const t = makeTools(
    deps({ readBudget: async () => ({ available: 1_000n, runningPending: 250n }) }),
  );
  expect(await t.getBudget()).toEqual({ remaining: 750n });
});

test("buyData buys via the Authority and returns the data + cost", async () => {
  const t = makeTools(deps());
  const r = await t.buyData("sentiment");
  expect(r).toMatchObject({ ok: true, cost: 10000n });
  expect((r as { data: { body: unknown } }).data).toMatchObject({ body: { index: 0.62 } });
});

test("getBudget clamps to 0 when runningPending exceeds available", async () => {
  const t = makeTools(
    deps({ readBudget: async () => ({ available: 100n, runningPending: 500n }) }),
  );
  expect(await t.getBudget()).toEqual({ remaining: 0n });
});

test("a policy-denied buy returns ok:false (no throw, no data)", async () => {
  const t = makeTools(deps({ authorize: async () => ({ ok: false, reason: "over-cap" }) }));
  const r = await t.buyData("sentiment");
  expect(r).toMatchObject({ ok: false, reason: "over-cap" });
});
