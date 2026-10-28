/**
 * The pilot composition: the chain side built from the pilot context, and the Kleros service the
 * mode selects. The mode picks the key and the deployment together, so a testnet run can never
 * read the live key and the reverse; a Proxy on `cfg.kleros` records every property read.
 */
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, expect, test, vi } from "vitest";
import { publicClientFor, sendClientFor, walletClientForKey } from "../../src/adapters/arc/clients";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { HttpDisputeService } from "../../src/adapters/kleros/httpDisputeService";
import { anvilChain } from "../../src/chains";
import type { Config, KlerosConfig, PilotKlerosMode } from "../../src/config/env";
import { buildKlerosService, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";

const API_URL = "https://kleros.example.com/mcp";
/** Placeholders: no Kleros key exists in this repository. */
const TESTNET_KEY = "placeholder-testnet-key";
const LIVE_KEY = "placeholder-live-key";

const KEYS = {
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  referee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

function klerosCfg(over: Partial<KlerosConfig> = {}): { kleros: KlerosConfig; reads: string[] } {
  const reads: string[] = [];
  const target: KlerosConfig = {
    apiKeyTestnet: TESTNET_KEY,
    apiKeyLive: LIVE_KEY,
    apiUrl: API_URL,
    courtIdTestnet: 9,
    courtIdLive: 35,
    aliasClient: "client",
    aliasProvider: "provider",
    expectedOptions: {},
    policyUri: "ipfs://policy",
    ...over,
  };
  const kleros = new Proxy(target, {
    get(t, p, r) {
      reads.push(String(p));
      return Reflect.get(t, p, r);
    },
  });
  return { kleros, reads };
}

function cfgFor(mode: PilotKlerosMode, kleros?: KlerosConfig): Config {
  return {
    chainId: anvilChain.id,
    rpcUrl: "http://127.0.0.1:1",
    pilot: {
      buyerPrivateKey: KEYS.buyer,
      sellerPrivateKey: KEYS.seller,
      refereePrivateKey: KEYS.referee,
      mode,
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: "https://api.example.com",
    },
    kleros,
  } as unknown as Config;
}

/** A stubbed global fetch that answers one tools/list page and records what was sent. */
function stubKlerosFetch() {
  const sent: { url: string; authorization: string | null }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      `event: message\ndata: ${JSON.stringify({ result: { tools: [{ name: "dispute_get" }] }, jsonrpc: "2.0", id: 1 })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return { fn, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("rehearsal builds the fake, with no deployment, cap or flag, and needs no Kleros config", async () => {
  const stage = buildKlerosService(cfgFor("rehearsal"), { script: "refund" });
  expect(stage.mode).toBe("rehearsal");
  expect(stage.service).toBeInstanceOf(FakeDisputeService);
  expect(stage.service.deployment).toBe("fake");
  expect(stage.deployment).toBeNull();
  expect(stage.cap).toBeNull();
  expect(stage.flag).toBeNull();
});

test("rehearsal reads no Kleros key at all, even when both are set", () => {
  const { kleros, reads } = klerosCfg();
  buildKlerosService(cfgFor("rehearsal", kleros), {});
  expect(reads).not.toContain("apiKeyTestnet");
  expect(reads).not.toContain("apiKeyLive");
});

test.each([
  ["testnet", TESTNET_KEY, "apiKeyLive", 9, 10, "--testnet"],
  ["live", LIVE_KEY, "apiKeyTestnet", 35, 5, "--live"],
] as const)(
  "%s builds the HTTP client with its own key, deployment, cap and flag, and never reads the other key",
  async (mode, key, otherKey, courtId, cap, flag) => {
    const { kleros, reads } = klerosCfg();
    const { sent } = stubKlerosFetch();
    const stage = buildKlerosService(cfgFor(mode, kleros), {});
    expect(stage.mode).toBe(mode);
    expect(stage.service).toBeInstanceOf(HttpDisputeService);
    expect(stage.service.deployment).toBe(mode);
    expect(stage.deployment).toEqual(deploymentFor(mode, courtId));
    expect(stage.cap).toBe(cap);
    expect(stage.flag).toBe(flag);
    expect(reads).not.toContain(otherKey);

    await stage.service.listTools();
    expect(sent).toEqual([{ url: API_URL, authorization: `Bearer ${key}` }]);
    expect(reads).not.toContain(otherKey);
  },
);

test.each([
  ["testnet", { apiKeyTestnet: undefined }, "KLEROS_API_KEY_TESTNET"],
  ["live", { apiKeyLive: undefined }, "KLEROS_API_KEY_LIVE"],
] as const)("%s without its key throws naming the variable, never a value", (mode, over, name) => {
  const { kleros } = klerosCfg(over);
  let message = "";
  try {
    buildKlerosService(cfgFor(mode, kleros), {});
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain(name);
  expect(message).not.toContain(TESTNET_KEY);
  expect(message).not.toContain(LIVE_KEY);
});

test.each(["testnet", "live"] as const)("%s without any Kleros config throws", (mode) => {
  expect(() => buildKlerosService(cfgFor(mode), {})).toThrow(/KLEROS_API_KEY_/);
});

test("rehearsal with realReads builds the named deployment's reader, whose writes throw before any fetch", async () => {
  const { kleros, reads } = klerosCfg();
  const { fn, sent } = stubKlerosFetch();
  const stage = buildKlerosService(cfgFor("rehearsal", kleros), { realReads: "live" });
  expect(stage.mode).toBe("rehearsal");
  expect(stage.service).toBeInstanceOf(HttpDisputeService);
  expect(stage.service.deployment).toBe("live");
  expect(stage.deployment).toEqual(deploymentFor("live", 35));
  expect(stage.cap).toBeNull();
  expect(stage.flag).toBeNull();
  expect(reads).not.toContain("apiKeyTestnet");

  await expect(stage.service.pin({ bytes: new Uint8Array([1]), extension: "txt" })).rejects.toThrow(
    /read/,
  );
  await expect(
    stage.service.createDispute({ aliases: { client: `0x${"11".repeat(20)}` as Address } }),
  ).rejects.toThrow(/read/);
  await expect(
    stage.service.submitEvidence({ coreDisputeId: "1", name: "n", description: "d" }),
  ).rejects.toThrow(/read/);
  expect(fn).not.toHaveBeenCalled();

  await stage.service.listTools();
  expect(sent).toEqual([{ url: API_URL, authorization: `Bearer ${LIVE_KEY}` }]);
});

test("realReads outside rehearsal is refused", () => {
  const { kleros } = klerosCfg();
  expect(() => buildKlerosService(cfgFor("testnet", kleros), { realReads: "testnet" })).toThrow(
    /rehearsal/,
  );
});

test("buildPilotChain: the buyer is the job client, the referee the evaluator, addresses from cfg", () => {
  const cfg = {
    ...cfgFor("rehearsal"),
    usdc: `0x${"36".repeat(20)}`,
    jobContract: `0x${"04".repeat(20)}`,
    identityRegistry: `0x${"05".repeat(20)}`,
    arcExplorerUrl: "https://explorer.example.com",
  } as unknown as Config;
  const ctx = {
    cfg,
    publicClient: publicClientFor(cfg),
    sendClient: sendClientFor(cfg),
    wallets: {
      buyer: walletClientForKey(cfg, KEYS.buyer),
      seller: walletClientForKey(cfg, KEYS.seller),
      referee: walletClientForKey(cfg, KEYS.referee),
    },
    addresses: {
      buyer: privateKeyToAccount(KEYS.buyer).address,
      seller: privateKeyToAccount(KEYS.seller).address,
      referee: privateKeyToAccount(KEYS.referee).address,
    },
  } as unknown as PilotContext;
  const chain = buildPilotChain(ctx);
  expect(chain.job.clientAddress()).toBe(ctx.addresses.buyer);
  expect(chain.job.evaluatorAddress()).toBe(ctx.addresses.referee);
  expect(chain.job.jobContract).toBe(cfg.jobContract);
  expect(chain.usdc).toBe(cfg.usdc);
  expect(chain.jobContract).toBe(cfg.jobContract);
  expect(chain.identityRegistry).toBe(cfg.identityRegistry);
  expect(chain.chainId).toBe(cfg.chainId);
  expect(chain.explorerBase).toBe("https://explorer.example.com");
  expect(chain.wallets).toBe(ctx.wallets);
  expect(chain.addresses).toBe(ctx.addresses);
  expect(chain.publicClient).toBe(ctx.publicClient);

  const fallback = buildPilotChain({
    ...ctx,
    cfg: { ...cfg, arcExplorerUrl: undefined } as Config,
  });
  expect(fallback.explorerBase).toMatch(/^https:\/\//);
});
