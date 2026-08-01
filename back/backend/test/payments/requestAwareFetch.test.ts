import { describe, expect, test, vi } from "vitest";
import { requestAwareSafeFetch } from "../../src/payments/ssrfGuard";

// The AgentKit client retries a 402 with a Request OBJECT. The old default pay fetch did
// `u as string`, turning it into the literal "[object Request]" and refusing — which broke every
// prod pay against an agentkit-enabled seller since the World wiring (caught live 2026-08-01 by
// the #65 checklist; the test harness handled Request itself, masking the prod seam).
// URLs use a public IP LITERAL so safeFetch skips its real DNS lookup (no seam to inject) and
// the tests stay hermetic — the fake fetch below is what answers, never the network.
describe("requestAwareSafeFetch", () => {
  function capture(status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
      calls.push({ url: String(u), init: i });
      return new Response("ok", { status });
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  test("a plain string URL passes through with SSRF checks intact", async () => {
    const { impl, calls } = capture();
    const f = requestAwareSafeFetch(impl);
    const res = await f("https://8.8.8.8/resource");
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("https://8.8.8.8/resource");
  });

  test("a Request OBJECT is unwrapped to its URL — method and headers preserved", async () => {
    const { impl, calls } = capture();
    const f = requestAwareSafeFetch(impl);
    const req = new Request("https://8.8.8.8/resource", {
      method: "GET",
      headers: { agentkit: "signed-proof-header" },
    });
    const res = await f(req);
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("https://8.8.8.8/resource"); // NOT "[object Request]"
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get("agentkit")).toBe("signed-proof-header"); // the proof survives the unwrap
  });

  test("init headers layered on a Request win (the retry's X-PAYMENT must not be dropped)", async () => {
    const { impl, calls } = capture();
    const f = requestAwareSafeFetch(impl);
    const req = new Request("https://8.8.8.8/resource", {
      headers: { agentkit: "a", "X-PAYMENT": "stale" },
    });
    await f(req, { headers: { "X-PAYMENT": "fresh" } });
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get("X-PAYMENT")).toBe("fresh");
    expect(h.get("agentkit")).toBe("a");
  });

  test("SSRF still bites on a Request pointing at a private address", async () => {
    const { impl } = capture();
    const f = requestAwareSafeFetch(impl);
    await expect(f(new Request("https://127.0.0.1/steal"))).rejects.toThrow(/blocked|localhost/i);
    expect(impl).not.toHaveBeenCalled();
  });
});
