/**
 * The `pilot:agent` helpers against a real chain: anvil, MockIdentityRegistry, MockUSDC.
 *
 * The context is built here the way `openPilotContext` builds it, from a config pointing at the
 * local chain, so `register` and `point` really sign, simulate and send.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { http, type Address, type Hex, createWalletClient, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mockIdentityRegistryAbi } from "../../src/abis/generated";
import { publicClientFor, sendClientFor, walletClientForKey } from "../../src/adapters/arc/clients";
import { anvilChain } from "../../src/chains";
import { registerPilotCommands } from "../../src/cli/pilot";
import type { Config } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import type { PilotContext } from "../../src/pilot/context";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { loadArtifact } from "../helpers/artifacts";

const DEPLOYER: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEYS = {
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  referee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

let anvil: AnvilHandle;
let ctx: PilotContext;

async function deploy(name: string, rpcUrl: string): Promise<Address> {
  const { abi, bytecode } = loadArtifact(name);
  const wallet = createWalletClient({
    account: privateKeyToAccount(DEPLOYER),
    chain: anvilChain,
    transport: http(rpcUrl),
  });
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [],
    account: wallet.account,
    chain: anvilChain,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`);
  return getAddress(receipt.contractAddress);
}

beforeAll(async () => {
  anvil = await startAnvil(8546);
  const cfg = {
    chainId: anvilChain.id,
    rpcUrl: anvil.rpcUrl,
    pilot: {
      buyerPrivateKey: KEYS.buyer,
      sellerPrivateKey: KEYS.seller,
      refereePrivateKey: KEYS.referee,
      mode: "rehearsal",
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: "https://api.example.com",
    },
  } as unknown as Config;
  const db = openDatabase(":memory:");
  migrate(db);
  ctx = {
    cfg,
    db,
    cases: new SqlitePilotCaseRepository(db),
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "pilot-agent-int-"))),
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
    close: () => {},
  };
  cfg.identityRegistry = await deploy("MockIdentityRegistry", anvil.rpcUrl);
  cfg.usdc = await deploy("MockUSDC", anvil.rpcUrl);
});

afterAll(() => {
  ctx?.db.close();
  anvil?.stop();
});

async function run(argv: string[]): Promise<Record<string, unknown>> {
  const program = new Command();
  program.exitOverride();
  registerPilotCommands(program, () => ctx);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", "pilot:agent", ...argv]);
  } finally {
    spy.mockRestore();
  }
  const out = logs.join("\n");
  for (const key of Object.values(KEYS)) expect(out).not.toContain(key.slice(2));
  return JSON.parse(out);
}

const ownerOf = (agentId: bigint) =>
  ctx.publicClient.readContract({
    address: ctx.cfg.identityRegistry,
    abi: mockIdentityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
  });

const nonceOf = (address: Address) => ctx.publicClient.getTransactionCount({ address });

describe("pilot:agent on anvil", () => {
  let buyerAgentId: bigint;

  test("register without --yes sends nothing", async () => {
    const before = await nonceOf(ctx.addresses.buyer);
    const printed = await run(["register", "--party", "buyer"]);
    expect(printed.dryRun).toBe(true);
    expect(await nonceOf(ctx.addresses.buyer)).toBe(before);
  });

  test("register --yes returns the minted id, and ownerOf names the party", async () => {
    // A seller identity first, so the buyer's id is not the zero a missing parse would also give.
    const seller = await run(["register", "--party", "seller", "--yes"]);
    expect(seller.agentId).toBe("0");
    const printed = await run([
      "register",
      "--party",
      "buyer",
      "--metadata-uri",
      "ipfs://x",
      "--yes",
    ]);
    expect(printed.party).toBe("buyer");
    expect(printed.address).toBe(ctx.addresses.buyer);
    expect(printed.agentId).toBe("1");
    expect(printed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    buyerAgentId = BigInt(printed.agentId as string);
    expect(await ownerOf(buyerAgentId)).toBe(ctx.addresses.buyer);
  });

  test("a second register --yes is refused without --again; with --again it mints id 2", async () => {
    const before = await nonceOf(ctx.addresses.buyer);
    await expect(run(["register", "--party", "buyer", "--yes"])).rejects.toThrow(
      /refusing: .*already holds an identity on the registry \(count 1\): pass --again/,
    );
    expect(await nonceOf(ctx.addresses.buyer)).toBe(before);

    const dry = await run(["register", "--party", "buyer"]);
    expect(dry.existingIdentities).toBe("1");

    const printed = await run(["register", "--party", "buyer", "--again", "--yes"]);
    expect(printed.agentId).toBe("2");
    expect(await ownerOf(2n)).toBe(ctx.addresses.buyer);
  });

  test("point --yes writes the legalBody metadata readable by getMetadata", async () => {
    const value = "0x00000000000000000000000000000000000000000000000000000000000beef1";
    const printed = await run([
      "point",
      "--party",
      "buyer",
      "--agent",
      buyerAgentId.toString(),
      "--value",
      value,
      "--yes",
    ]);
    expect(printed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const stored = await ctx.publicClient.readContract({
      address: ctx.cfg.identityRegistry,
      abi: mockIdentityRegistryAbi,
      functionName: "getMetadata",
      args: [buyerAgentId, "legalBody"],
    });
    expect(stored).toBe(value);
  });

  test("point from the wrong party is refused before any send", async () => {
    const before = await nonceOf(ctx.addresses.seller);
    await expect(
      run([
        "point",
        "--party",
        "seller",
        "--agent",
        buyerAgentId.toString(),
        "--value",
        "0x01",
        "--yes",
      ]),
    ).rejects.toThrow(/refusing: agent 1 is owned by/);
    expect(await nonceOf(ctx.addresses.seller)).toBe(before);
  });

  test("show reads the USDC balance and ownerOf from the chain", async () => {
    // viem's transport fetches too: only the lookup URL is answered here, the rest goes to anvil.
    const realFetch = globalThis.fetch;
    const lookups: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.example.com/")) return realFetch(input, init);
      lookups.push(url);
      return Promise.resolve(
        Response.json({ agentId: "1", legalBody: false, standing: null, checkedAt: "x" }),
      );
    });
    try {
      const printed = await run(["show", "--party", "buyer", "--agent", buyerAgentId.toString()]);
      expect(printed.usdcBalanceAtomic).toBe("0");
      expect(printed.ownerOf).toBe(ctx.addresses.buyer);
      expect(printed.lookup).toMatchObject({ legalBody: false, standing: null });
      expect(lookups).toEqual(["https://api.example.com/legal-bodies/by-agent/1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
