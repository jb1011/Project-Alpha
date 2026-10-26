/**
 * The `pilot:agent` helpers over a fake PilotContext: no chain, no database, no network.
 *
 * The wallets are real viem wallet clients over local accounts, on a transport that refuses every
 * request: signing needs no transport, so any request it records is a call the command should not
 * have made.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  getAddress,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type MockInstance, afterEach, describe, expect, test, vi } from "vitest";
import { iIdentityRegistryAbi } from "../../src/abis/generated";
import { anvilChain } from "../../src/chains";
import { registerPilotCommands } from "../../src/cli/pilot";
import { linkTypedDataWire, linkVerifyTypes } from "../../src/legalBody/link";
import type { PilotContext } from "../../src/pilot/context";

const KEYS = {
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  referee: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;

const REGISTRY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const USDC: Address = "0x3600000000000000000000000000000000000000";
const FACTORY: Address = getAddress("0x00000000000000000000000000000000000fac70");
const CHAIN_ID = anvilChain.id;
const LOOKUP_BASE = "https://api.example.com";

const OTHER: Address = "0x000000000000000000000000000000000000dEaD";

interface Fake {
  ctx: PilotContext;
  transportCalls: string[];
  pub: {
    readContract: ReturnType<typeof vi.fn>;
    simulateContract: ReturnType<typeof vi.fn>;
    waitForTransactionReceipt: ReturnType<typeof vi.fn>;
    getTransactionReceipt: ReturnType<typeof vi.fn>;
  };
  writes: MockInstance[];
  closed: () => number;
}

function makeFake(read: (fn: string, args: readonly unknown[]) => unknown = () => 0n): Fake {
  const transportCalls: string[] = [];
  const transport = custom({
    request: async ({ method }: { method: string }) => {
      transportCalls.push(method);
      throw new Error(`no network in this test: ${method}`);
    },
  });
  const wallet = (key: Hex): WalletClient =>
    createWalletClient({ account: privateKeyToAccount(key), chain: anvilChain, transport });
  const wallets = {
    buyer: wallet(KEYS.buyer),
    seller: wallet(KEYS.seller),
    referee: wallet(KEYS.referee),
  };
  const writes = Object.values(wallets).map((w) => vi.spyOn(w, "writeContract"));

  const pub = {
    readContract: vi.fn(async (p: { functionName: string; args?: readonly unknown[] }) =>
      read(p.functionName, p.args ?? []),
    ),
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
  };
  let closes = 0;
  const ctx = {
    cfg: {
      chainId: CHAIN_ID,
      identityRegistry: REGISTRY,
      usdc: USDC,
      legalBodyFactory: FACTORY,
      pilot: {
        buyerPrivateKey: KEYS.buyer,
        sellerPrivateKey: KEYS.seller,
        refereePrivateKey: KEYS.referee,
        mode: "rehearsal",
        testnetCasesCap: 10,
        liveCasesCap: 5,
        lookupBase: LOOKUP_BASE,
      },
    },
    db: {},
    cases: {},
    docStore: {},
    publicClient: pub as unknown as PublicClient,
    sendClient: pub as unknown as PublicClient,
    wallets,
    addresses: {
      buyer: privateKeyToAccount(KEYS.buyer).address,
      seller: privateKeyToAccount(KEYS.seller).address,
      referee: privateKeyToAccount(KEYS.referee).address,
    },
    close: () => {
      closes++;
    },
  } as unknown as PilotContext;
  return { ctx, transportCalls, pub, writes, closed: () => closes };
}

/** Runs one command line; returns what it printed. Throws what the command throws. */
async function run(fake: Fake, argv: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPilotCommands(program, () => fake.ctx);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", "pilot:agent", ...argv]);
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

function expectNoKey(output: string): void {
  for (const key of Object.values(KEYS)) {
    expect(output).not.toContain(key);
    expect(output).not.toContain(key.slice(2));
  }
}

function expectNothingSent(fake: Fake): void {
  expect(fake.pub.simulateContract).not.toHaveBeenCalled();
  for (const w of fake.writes) expect(w).not.toHaveBeenCalled();
  expect(fake.transportCalls).toEqual([]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pilot:agent register", () => {
  test("the dry run prints the decoded register call with an empty URI and sends nothing", async () => {
    const fake = makeFake();
    const out = await run(fake, ["register", "--party", "buyer"]);
    const printed = JSON.parse(out);
    expect(printed.dryRun).toBe(true);
    expect(printed.party).toBe("buyer");
    expect(printed.address).toBe(fake.ctx.addresses.buyer);
    expect(printed.contract).toBe(REGISTRY);
    expect(printed.call).toEqual({ functionName: "register", args: [""] });
    const decoded = decodeFunctionData({ abi: iIdentityRegistryAbi, data: printed.data });
    expect(decoded.functionName).toBe("register");
    expect(decoded.args).toEqual([""]);
    expectNothingSent(fake);
    expectNoKey(out);
    expect(fake.closed()).toBe(1);
  });

  test("--metadata-uri is the register argument", async () => {
    const fake = makeFake();
    const out = await run(fake, [
      "register",
      "--party",
      "seller",
      "--metadata-uri",
      "https://api.example.com/agents/seller.json",
    ]);
    const printed = JSON.parse(out);
    expect(printed.address).toBe(fake.ctx.addresses.seller);
    expect(printed.call.args).toEqual(["https://api.example.com/agents/seller.json"]);
    expectNothingSent(fake);
  });

  test("a party other than buyer or seller is refused", async () => {
    const fake = makeFake();
    await expect(run(fake, ["register", "--party", "referee", "--yes"])).rejects.toThrow(
      /refusing: --party must be buyer or seller/,
    );
    expectNothingSent(fake);
  });

  test("a missing --party is a usage error", async () => {
    const fake = makeFake();
    await expect(run(fake, ["register"])).rejects.toThrow(/--party/);
    expectNothingSent(fake);
  });
});

describe("pilot:agent point", () => {
  const VALUE = "0x000000000000000000000000000000000000beef";

  test("the dry run checks the owner and prints the decoded setMetadata call, sending nothing", async () => {
    const fake = makeFake((fn) =>
      fn === "ownerOf" ? privateKeyToAccount(KEYS.buyer).address : 0n,
    );
    const out = await run(fake, ["point", "--party", "buyer", "--agent", "42", "--value", VALUE]);
    const printed = JSON.parse(out);
    expect(printed.dryRun).toBe(true);
    expect(printed.call).toEqual({
      functionName: "setMetadata",
      args: ["42", "legalBody", VALUE],
    });
    const decoded = decodeFunctionData({ abi: iIdentityRegistryAbi, data: printed.data });
    expect(decoded.functionName).toBe("setMetadata");
    expect(decoded.args).toEqual([42n, "legalBody", VALUE]);
    expect(fake.pub.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: "ownerOf", args: [42n] }),
    );
    expectNothingSent(fake);
    expectNoKey(out);
  });

  test("refuses when ownerOf names another address, before any send", async () => {
    const fake = makeFake((fn) => (fn === "ownerOf" ? OTHER : 0n));
    await expect(
      run(fake, ["point", "--party", "buyer", "--agent", "42", "--value", VALUE, "--yes"]),
    ).rejects.toThrow(/refusing: agent 42 is owned by 0x000000000000000000000000000000000000dEaD/);
    expectNothingSent(fake);
    expect(fake.closed()).toBe(1);
  });

  test("refuses a value that is not whole bytes of hex, and an agent id that is not a decimal", async () => {
    const fake = makeFake((fn) => (fn === "ownerOf" ? fake.ctx.addresses.buyer : 0n));
    await expect(
      run(fake, ["point", "--party", "buyer", "--agent", "42", "--value", "0xabc"]),
    ).rejects.toThrow(/refusing: --value/);
    await expect(
      run(fake, ["point", "--party", "buyer", "--agent", "-1", "--value", VALUE]),
    ).rejects.toThrow(/refusing: --agent/);
    expect(fake.pub.readContract).not.toHaveBeenCalled();
    expectNothingSent(fake);
  });
});

describe("pilot:agent sign-link", () => {
  function typedDataFile(
    over: (t: Record<string, unknown>) => Record<string, unknown> = (t) => t,
  ): string {
    const wire = linkTypedDataWire({
      chainId: CHAIN_ID,
      factory: FACTORY,
      link: {
        agentId: 42n,
        guardian: OTHER,
        amendmentDelay: 172_800n,
        operatingAgreementHash: `0x${"ab".repeat(32)}`,
        deadline: 1_900_000_000n,
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "pilot-sign-link-"));
    const path = join(dir, "typed-data.json");
    writeFileSync(path, JSON.stringify(over(wire as unknown as Record<string, unknown>)));
    return path;
  }

  test("signs the served link typed data with the party's account; the signature verifies", async () => {
    const fake = makeFake();
    const out = await run(fake, [
      "sign-link",
      "--party",
      "seller",
      "--typed-data",
      typedDataFile(),
    ]);
    const printed = JSON.parse(out);
    expect(printed.party).toBe("seller");
    expect(printed.address).toBe(fake.ctx.addresses.seller);
    const valid = await verifyTypedData({
      address: fake.ctx.addresses.seller,
      domain: {
        name: "Novi LegalBodyFactory",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: FACTORY,
      },
      types: linkVerifyTypes(),
      primaryType: "LegalBodyLink",
      message: {
        agentId: 42n,
        guardian: OTHER,
        amendmentDelay: 172_800n,
        operatingAgreementHash: `0x${"ab".repeat(32)}`,
        deadline: 1_900_000_000n,
      },
      signature: printed.signature,
    });
    expect(valid).toBe(true);
    expect(Object.keys(printed).sort()).toEqual(["address", "party", "signature"]);
    expectNothingSent(fake);
    expect(fake.pub.readContract).not.toHaveBeenCalled();
    expectNoKey(out);
  });

  test("refuses typed data that is not the link message (a payment authorization, say)", async () => {
    const fake = makeFake();
    const path = typedDataFile((t) => ({ ...t, primaryType: "TransferWithAuthorization" }));
    await expect(
      run(fake, ["sign-link", "--party", "buyer", "--typed-data", path]),
    ).rejects.toThrow(/refusing: the typed data is not the legal-body link message/);
  });

  test("refuses a link for another chain or another factory", async () => {
    const fake = makeFake();
    const otherChain = typedDataFile((t) => ({
      ...t,
      domain: { ...(t.domain as object), chainId: CHAIN_ID + 1 },
    }));
    await expect(
      run(fake, ["sign-link", "--party", "buyer", "--typed-data", otherChain]),
    ).rejects.toThrow(/refusing: the link's domain/);
    const otherFactory = typedDataFile((t) => ({
      ...t,
      domain: { ...(t.domain as object), verifyingContract: OTHER },
    }));
    await expect(
      run(fake, ["sign-link", "--party", "buyer", "--typed-data", otherFactory]),
    ).rejects.toThrow(/refusing: the link's domain/);
  });
});

describe("pilot:agent show", () => {
  test("prints the address, the USDC balance, ownerOf and the lookup's legalBody and standing", async () => {
    const fake = makeFake((fn) => {
      if (fn === "balanceOf") return 1_500_000n;
      if (fn === "ownerOf") return privateKeyToAccount(KEYS.buyer).address;
      throw new Error(`unexpected read ${fn}`);
    });
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ agentId: "42", legalBody: true, standing: "active", checkedAt: "x" }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await run(fake, ["show", "--party", "buyer", "--agent", "42"]);
    const printed = JSON.parse(out);
    expect(printed).toEqual({
      party: "buyer",
      address: fake.ctx.addresses.buyer,
      usdcBalance: "1.5",
      usdcBalanceAtomic: "1500000",
      agentId: "42",
      ownerOf: fake.ctx.addresses.buyer,
      lookup: {
        url: `${LOOKUP_BASE}/legal-bodies/by-agent/42`,
        legalBody: true,
        standing: "active",
      },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${LOOKUP_BASE}/legal-bodies/by-agent/42`);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.pub.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USDC,
        functionName: "balanceOf",
        args: [fake.ctx.addresses.buyer],
      }),
    );
    expectNothingSent(fake);
    expectNoKey(out);
  });

  test("without --agent there is no ownerOf and no lookup", async () => {
    const fake = makeFake((fn) => (fn === "balanceOf" ? 0n : OTHER));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const printed = JSON.parse(await run(fake, ["show", "--party", "seller"]));
    expect(printed.ownerOf).toBeNull();
    expect(printed.lookup).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
