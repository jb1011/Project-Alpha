/**
 * The legal-body chain layer: the pointer against the value the live testnet body carries, the
 * selectors of the pinned fragments, one refusing case per rule of the allowlist (and its order),
 * the send door, and the mint parse. Every request a wallet could be handed goes through
 * `allowedCall`; these tables are what it refuses.
 */
import { describe, expect, test, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  toBytes,
  toEventSelector,
  toFunctionSelector,
  type AbiFunction,
} from "viem";
import {
  agentIdFromMint,
  allowedCall,
  encodePointer,
  formatNative,
  identityRegistryAbi,
  legalBodyFactoryAbi,
  NATIVE_DECIMALS,
  pointerCall,
  pointerMatchesFactory,
  POINTER_KEY,
  POINTER_VERSION,
  registerCall,
  sendAllowedCall,
  TRANSFER_TOPIC,
  walletKindOf,
  type CallContext,
  type WriteRequest,
} from "@/lib/legalBody/chain";
import { arcTestnet } from "@/lib/chain";
import type { Address, Hex, LegalBodyOrderView } from "@/lib/api/types";

/** The public testnet identity registry and factory, and the live test body (agent 897126). */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
/** Two of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** Inventions. */
const ANOTHER_CONTRACT = "0x00000000000000000000000000000000000c0de1" as const;
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const ANOTHER_BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;
const OTHER_CHAIN = 5042;

/** The pointer for chain 5042002 (0x4cef52) and the live body, written out word by word:
 *  version 1, the chain id, the body address. */
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;

const upper = (a: string) => `0x${a.slice(2).toUpperCase()}` as Address;
const lower = (a: string) => a.toLowerCase() as Address;

const config: CallContext["config"] = { chainId: CHAIN, identityRegistry: REGISTRY, factory: FACTORY };

/** A deployed body waiting for its pointer, on the configured deployment. */
const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lb_a",
  publicId: "pub_a",
  companyId: "co_a",
  state: "deployed",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"9c".repeat(32)}`, version: 1 },
  agentId: LIVE_AGENT,
  identityOwner: GUARDIAN,
  bodyAddress: LIVE_BODY,
  linkDeadline: 1_791_003_600,
  createTxHash: `0x${"ab".repeat(32)}`,
  deployedAt: 1_791_000_000,
  pointerSeenAt: null,
  createdAt: "2026-10-12T10:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/** The pointer request for the default order, as the flow builds it. */
function goodPointer(): WriteRequest {
  const req = pointerCall(config, order());
  if ("ok" in req) throw new Error(`the pointer call was refused: ${req.problem}`);
  return req;
}

const ctx: CallContext = { config, order: order() };

describe("the pinned values", () => {
  test("the pointer key, its version and Arc's native decimals", () => {
    expect(POINTER_KEY).toBe("legalBody");
    expect(POINTER_VERSION).toBe(1);
    expect(NATIVE_DECIMALS).toBe(18);
    expect(NATIVE_DECIMALS).toBe(arcTestnet.nativeCurrency.decimals);
  });

  test("the Transfer topic is the pinned event's selector", () => {
    expect(TRANSFER_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(keccak256(toBytes("Transfer(address,address,uint256)"))).toBe(TRANSFER_TOPIC);
    const transfer = identityRegistryAbi.find((i) => i.type === "event" && i.name === "Transfer");
    if (!transfer || transfer.type !== "event") throw new Error("no Transfer event in the fragment");
    expect(toEventSelector(transfer)).toBe(TRANSFER_TOPIC);
  });

  test("the three writes carry the selectors the live run used", () => {
    const fn = (name: string, inputs: number): AbiFunction => {
      const item = identityRegistryAbi.find(
        (i) => i.type === "function" && i.name === name && i.inputs.length === inputs,
      );
      if (!item || item.type !== "function") throw new Error(`no ${name}/${inputs} in the fragment`);
      return item;
    };
    expect(toFunctionSelector(fn("register", 0))).toBe("0x1aa3a008");
    expect(toFunctionSelector(fn("register", 1))).toBe("0xf2c298be");
    expect(toFunctionSelector(fn("setMetadata", 3))).toBe("0x466648da");
  });

  test("the registry fragment holds no write beyond the three the allowlist names", () => {
    const writes = identityRegistryAbi
      .filter((i) => i.type === "function" && i.stateMutability !== "view")
      .map((i) => (i.type === "function" ? toFunctionSelector(i) : ""));
    expect(writes.sort()).toEqual(["0x1aa3a008", "0x466648da", "0xf2c298be"]);
    const mutability = identityRegistryAbi.map((i) => (i.type === "function" ? i.stateMutability : "event"));
    expect(new Set(mutability)).toEqual(new Set(["nonpayable", "view", "event"]));
  });

  test("the factory fragment holds the pointer step's three reads, all views", () => {
    expect(
      legalBodyFactoryAbi.map((i) => `${i.name}(${i.inputs.map((p) => p.type).join(",")})`),
    ).toEqual(["encodePointer(address)", "linkedLegalBody(uint256)", "identityOwnerAtCreation(address)"]);
    expect(legalBodyFactoryAbi.every((i) => i.stateMutability === "view")).toBe(true);
  });
});

describe("the pointer", () => {
  test("for chain 5042002 and the live body it is the value on chain, 96 bytes", () => {
    const p = encodePointer(CHAIN, LIVE_BODY);
    expect(p).toBe(LIVE_POINTER);
    expect((p.length - 2) / 2).toBe(96);
  });

  test("the body's casing does not change the encoding", () => {
    expect(encodePointer(CHAIN, lower(LIVE_BODY))).toBe(LIVE_POINTER);
  });

  test("pointerMatchesFactory compares without regard to case", () => {
    const local = encodePointer(CHAIN, LIVE_BODY);
    expect(pointerMatchesFactory(local, LIVE_POINTER)).toBe(true);
    expect(pointerMatchesFactory(local, upper(LIVE_POINTER) as Hex)).toBe(true);
    expect(pointerMatchesFactory(upper(local) as Hex, LIVE_POINTER)).toBe(true);
  });

  test("pointerMatchesFactory refuses another chain's value, another body, a cut value", () => {
    const local = encodePointer(CHAIN, LIVE_BODY);
    expect(pointerMatchesFactory(local, encodePointer(OTHER_CHAIN, LIVE_BODY))).toBe(false);
    expect(pointerMatchesFactory(local, encodePointer(CHAIN, ANOTHER_BODY))).toBe(false);
    expect(pointerMatchesFactory(local, local.slice(0, -2) as Hex)).toBe(false);
    expect(pointerMatchesFactory(local, "0x")).toBe(false);
  });

  test("a native amount reads with 18 decimals", () => {
    expect(formatNative(BigInt("10000000000000000"))).toBe("0.01");
    expect(formatNative(BigInt("1000000000000000000"))).toBe("1");
    expect(formatNative(BigInt(0))).toBe("0");
  });
});

describe("walletKindOf", () => {
  const delegation = `0xef0100${"12".repeat(20)}` as Hex;
  test.each<[string, Hex | undefined, string]>([
    ["no code read", undefined, "key"],
    ["an empty code", "0x", "key"],
    ["a 23-byte delegation", delegation, "delegated"],
    ["a 23-byte delegation in upper case", upper(delegation) as Hex, "delegated"],
    ["23 bytes with another prefix", `0xef0200${"12".repeat(20)}`, "contract"],
    ["a delegation prefix on 24 bytes", `${delegation}00`, "contract"],
    ["a contract's code", `0x6080604052${"00".repeat(200)}`, "contract"],
  ])("%s", (_name, code, kind) => {
    expect(walletKindOf(code)).toBe(kind);
  });
});

describe("the request builders", () => {
  test("registerCall without a URI is register()", () => {
    expect(registerCall(config, null)).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "register",
      args: [],
    });
    expect(registerCall(config, null).abi).toBe(identityRegistryAbi);
  });

  test("registerCall with a URI is register(string)", () => {
    expect(registerCall(config, "https://example.com/agent.json")).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "register",
      args: ["https://example.com/agent.json"],
    });
  });

  test("pointerCall writes the order's own pointer under the pinned key", () => {
    expect(pointerCall(config, order())).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "setMetadata",
      args: [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER],
    });
  });

  test.each<[string, Partial<LegalBodyOrderView>]>([
    ["no identity", { agentId: null }],
    ["no body", { bodyAddress: null }],
    ["an identity that is not a canonical decimal", { agentId: "0x1" }],
    ["a body that is not an address", { bodyAddress: "0x1234" }],
  ])("pointerCall refuses an order with %s", (_name, over) => {
    expect(pointerCall(config, order(over))).toEqual({ ok: false, problem: "order_has_no_body" });
  });
});

describe("allowedCall accepts", () => {
  test("register(): the calldata is the bare selector", () => {
    expect(allowedCall(registerCall(config, null), { config, order: null })).toEqual({
      ok: true,
      data: "0x1aa3a008",
    });
  });

  test("register(string): the calldata starts with its selector", () => {
    const out = allowedCall(registerCall(config, "https://example.com/agent.json"), {
      config,
      order: null,
    });
    if (!out.ok) throw new Error(out.problem);
    expect(out.data.slice(0, 10)).toBe("0xf2c298be");
    expect(out.data).toBe(
      encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "register",
        args: ["https://example.com/agent.json"],
      }),
    );
  });

  test("the pointer: the calldata starts with setMetadata's selector and says what it writes", () => {
    const out = allowedCall(goodPointer(), ctx);
    if (!out.ok) throw new Error(out.problem);
    expect(out.data.slice(0, 10)).toBe("0x466648da");
    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: out.data });
    expect(decoded.functionName).toBe("setMetadata");
    expect(decoded.args).toEqual([BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER]);
  });

  test("the pointer for a body whose pointer was cleared", () => {
    const broken = order({ state: "broken", brokenReason: "not_linked" });
    expect(allowedCall(goodPointer(), { config, order: broken }).ok).toBe(true);
  });

  test("addresses and the pointer in another case", () => {
    const req = goodPointer();
    const mixed: WriteRequest = {
      ...req,
      address: lower(REGISTRY),
      args: [BigInt(LIVE_AGENT), "legalBody", upper(LIVE_POINTER)],
    };
    const shouted = order({ factory: upper(FACTORY), bodyAddress: lower(LIVE_BODY) });
    expect(allowedCall(mixed, { config, order: shouted }).ok).toBe(true);
  });

  test("a zero value", () => {
    expect(allowedCall({ ...registerCall(config, null), value: BigInt(0) }, ctx).ok).toBe(true);
  });
});

describe("allowedCall refuses", () => {
  const good = goodPointer();
  const reg = registerCall(config, "https://example.com/agent.json");
  const agent = BigInt(LIVE_AGENT);
  const cases: [string, WriteRequest, CallContext, string][] = [
    ["a call that sends value", { ...good, value: BigInt(1) }, ctx, "sends_value"],
    ["a register that sends value", { ...reg, value: BigInt(1) }, ctx, "sends_value"],
    ["another chain", { ...good, chainId: OTHER_CHAIN }, ctx, "wrong_chain"],
    ["another contract", { ...good, address: ANOTHER_CONTRACT }, ctx, "not_the_registry"],
    [
      "an ABI equal to the pinned one but not it",
      { ...good, abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi },
      ctx,
      "not_the_pinned_abi",
    ],
    ["register with two arguments", { ...reg, args: ["a", "b"] }, ctx, "register_args"],
    ["register with a number", { ...reg, args: [BigInt(1)] }, ctx, "register_args"],
    ["register whose arguments are not a list", { ...reg, args: "https://example.com" as unknown as unknown[] }, ctx, "register_args"],
    ["a pointer with no order selected", good, { config, order: null }, "no_order"],
    [
      "a pointer for an order on another chain",
      good,
      { config, order: order({ chainId: OTHER_CHAIN }) },
      "order_on_another_deployment",
    ],
    [
      "a pointer for an order of another factory",
      good,
      { config, order: order({ factory: ANOTHER_FACTORY }) },
      "order_on_another_deployment",
    ],
    ["a pointer at a draft", good, { config, order: order({ state: "draft" }) }, "order_not_pointable"],
    ["a pointer at a reservation", good, { config, order: order({ state: "reserved" }) }, "order_not_pointable"],
    ["a pointer at a linked body", good, { config, order: order({ state: "linked" }) }, "order_not_pointable"],
    [
      "a pointer at a replaced body",
      good,
      { config, order: order({ state: "broken", brokenReason: "replaced" }) },
      "order_not_pointable",
    ],
    [
      "a pointer at a body winding down",
      good,
      { config, order: order({ state: "broken", brokenReason: "winding_down" }) },
      "order_not_pointable",
    ],
    [
      "a pointer while broken with no served reason",
      good,
      { config, order: order({ state: "broken", brokenReason: null }) },
      "order_not_pointable",
    ],
    [
      "a pointer at a superseded body",
      good,
      { config, order: order({ state: "superseded", brokenReason: "not_linked" }) },
      "order_not_pointable",
    ],
    ["a pointer at a revoked body", good, { config, order: order({ revoked: true }) }, "order_not_pointable"],
    [
      "a pointer at a revoked body whose pointer was cleared",
      good,
      { config, order: order({ state: "broken", brokenReason: "not_linked", revoked: true }) },
      "order_not_pointable",
    ],
    ["a pointer for an order with no identity", good, { config, order: order({ agentId: null }) }, "order_has_no_body"],
    ["a pointer for an order with no body", good, { config, order: order({ bodyAddress: null }) }, "order_has_no_body"],
    [
      "a pointer for an order whose identity is not a canonical decimal",
      good,
      { config, order: order({ agentId: "" }) },
      "order_has_no_body",
    ],
    [
      "a pointer for an order whose body is not an address",
      good,
      { config, order: order({ bodyAddress: "0xb0d1e" }) },
      "order_has_no_body",
    ],
    ["setMetadata with two arguments", { ...good, args: [agent, "legalBody"] }, ctx, "set_metadata_args"],
    [
      "setMetadata with four arguments",
      { ...good, args: [agent, "legalBody", LIVE_POINTER, "0x"] },
      ctx,
      "set_metadata_args",
    ],
    ["setMetadata whose arguments are not a list", { ...good, args: undefined as unknown as unknown[] }, ctx, "set_metadata_args"],
    ["a pointer for another identity", { ...good, args: [BigInt(1), "legalBody", LIVE_POINTER] }, ctx, "other_identity"],
    ["an identity as a string", { ...good, args: [LIVE_AGENT, "legalBody", LIVE_POINTER] }, ctx, "other_identity"],
    ["another metadata key", { ...good, args: [agent, "agentWallet", LIVE_POINTER] }, ctx, "other_key"],
    ["the key in another case", { ...good, args: [agent, "LegalBody", LIVE_POINTER] }, ctx, "other_key"],
    [
      "a pointer at another body",
      { ...good, args: [agent, "legalBody", encodePointer(CHAIN, ANOTHER_BODY)] },
      ctx,
      "other_body",
    ],
    [
      "a pointer that names another chain",
      { ...good, args: [agent, "legalBody", encodePointer(OTHER_CHAIN, LIVE_BODY)] },
      ctx,
      "other_body",
    ],
    ["a pointer value that is not a string", { ...good, args: [agent, "legalBody", BigInt(1)] }, ctx, "other_body"],
    [
      "a function outside the list",
      { ...good, functionName: "transferFrom" as unknown as WriteRequest["functionName"] },
      ctx,
      "not_allowed",
    ],
  ];

  test.each(cases)("%s", (_name, req, c, problem) => {
    expect(allowedCall(req, c)).toEqual({ ok: false, problem });
  });

  test("covers every problem the allowlist can name", () => {
    expect(new Set(cases.map((c) => c[3]))).toEqual(
      new Set([
        "sends_value",
        "wrong_chain",
        "not_the_registry",
        "not_the_pinned_abi",
        "register_args",
        "no_order",
        "order_on_another_deployment",
        "order_not_pointable",
        "order_has_no_body",
        "set_metadata_args",
        "other_identity",
        "other_key",
        "other_body",
        "not_allowed",
      ]),
    );
  });

  test("the first rule broken names the problem, in the order the rules are written", () => {
    const stranger = order({ factory: ANOTHER_FACTORY, state: "linked", agentId: null });
    const everything: WriteRequest = {
      ...good,
      value: BigInt(1),
      chainId: OTHER_CHAIN,
      address: ANOTHER_CONTRACT,
      abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi,
      args: [BigInt(1), "agentWallet"],
    };
    const steps: [WriteRequest, CallContext, string][] = [
      [everything, { config, order: stranger }, "sends_value"],
      [{ ...everything, value: undefined }, { config, order: stranger }, "wrong_chain"],
      [{ ...everything, value: undefined, chainId: CHAIN }, { config, order: stranger }, "not_the_registry"],
      [
        { ...everything, value: undefined, chainId: CHAIN, address: REGISTRY },
        { config, order: stranger },
        "not_the_pinned_abi",
      ],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: null }, "no_order"],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: stranger }, "order_on_another_deployment"],
      [
        { ...good, args: [BigInt(1), "agentWallet"] },
        { config, order: order({ state: "linked", agentId: null }) },
        "order_not_pointable",
      ],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: order({ agentId: null }) }, "order_has_no_body"],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, ctx, "set_metadata_args"],
      [{ ...good, args: [BigInt(1), "agentWallet", "0x"] }, ctx, "other_identity"],
      [{ ...good, args: [agent, "agentWallet", "0x"] }, ctx, "other_key"],
      [{ ...good, args: [agent, "legalBody", "0x"] }, ctx, "other_body"],
    ];
    for (const [req, c, problem] of steps) expect(allowedCall(req, c)).toEqual({ ok: false, problem });
  });
});

describe("sendAllowedCall", () => {
  const req = goodPointer();
  const wallet = () => vi.fn<(req: WriteRequest) => Promise<Hex>>(async () => "0xabc");

  test("a wallet on another chain: no prompt, never a silent switch", async () => {
    const writeContract = wallet();
    expect(
      await sendAllowedCall(req, ctx, { walletChainId: 1, configuredChainIds: [CHAIN], writeContract }),
    ).toEqual({ ok: false, problem: "wallet_on_another_chain" });
    expect(
      await sendAllowedCall(req, ctx, {
        walletChainId: undefined,
        configuredChainIds: [CHAIN],
        writeContract,
      }),
    ).toEqual({ ok: false, problem: "wallet_on_another_chain" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a chain this site is not configured for: no prompt", async () => {
    const writeContract = wallet();
    expect(
      await sendAllowedCall(req, ctx, {
        walletChainId: CHAIN,
        configuredChainIds: [OTHER_CHAIN],
        writeContract,
      }),
    ).toEqual({ ok: false, problem: "chain_not_configured" });
    // Checked before the wallet's chain.
    expect(
      await sendAllowedCall(req, ctx, { walletChainId: 1, configuredChainIds: [], writeContract }),
    ).toEqual({ ok: false, problem: "chain_not_configured" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a refused call never reaches the wallet, and the allowlist speaks first", async () => {
    const writeContract = wallet();
    const bad: WriteRequest = { ...req, args: [BigInt(LIVE_AGENT), "legalBody", encodePointer(CHAIN, ANOTHER_BODY)] };
    expect(
      await sendAllowedCall(bad, ctx, { walletChainId: CHAIN, configuredChainIds: [CHAIN], writeContract }),
    ).toEqual({ ok: false, problem: "other_body" });
    expect(
      await sendAllowedCall(bad, ctx, { walletChainId: 1, configuredChainIds: [], writeContract }),
    ).toEqual({ ok: false, problem: "other_body" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("an allowed call is sent once, its gas passed through untouched", async () => {
    const writeContract = wallet();
    const gas = BigInt(123_456);
    const withGas: WriteRequest = { ...req, gas };
    const out = await sendAllowedCall(withGas, ctx, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    const checked = allowedCall(withGas, ctx);
    if (!checked.ok) throw new Error(checked.problem);
    expect(out).toEqual({ ok: true, hash: "0xabc", data: checked.data });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(withGas);
    const sent = writeContract.mock.calls[0][0];
    expect(sent.gas).toBe(gas);
    expect(sent.abi).toBe(identityRegistryAbi);
  });

  test("a register is sent as built, without a gas it was not given", async () => {
    const writeContract = wallet();
    const reg = registerCall(config, null);
    const out = await sendAllowedCall(reg, { config, order: null }, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    expect(out).toEqual({ ok: true, hash: "0xabc", data: "0x1aa3a008" });
    expect(writeContract).toHaveBeenCalledWith(reg);
    expect("gas" in writeContract.mock.calls[0][0]).toBe(false);
  });

  test("the wallet gets the arguments the allowlist checked, not the caller's array", async () => {
    // wagmi reads the request's variables a tick later, after its own `onMutate`.
    let seen: readonly unknown[] = [];
    const writeContract = vi.fn<(r: WriteRequest) => Promise<Hex>>(async (r) => {
      await Promise.resolve();
      seen = [...r.args];
      return "0xabc";
    });
    const args: unknown[] = [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER];
    const pending = sendAllowedCall({ ...req, args }, ctx, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    args[2] = encodePointer(CHAIN, ANOTHER_BODY);
    expect((await pending).ok).toBe(true);
    expect(seen).toEqual([BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER]);
    expect(writeContract.mock.calls[0][0].args).not.toBe(args);
  });

  test("only the checked fields reach the wallet", async () => {
    const writeContract = wallet();
    const padded = { ...req, dataSuffix: "0xdeadbeef", nonce: 7 } as WriteRequest;
    await sendAllowedCall(padded, ctx, { walletChainId: CHAIN, configuredChainIds: [CHAIN], writeContract });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(req);
    expect(Object.keys(writeContract.mock.calls[0][0]).sort()).toEqual(
      ["abi", "address", "args", "chainId", "functionName"].sort(),
    );
  });
});

describe("agentIdFromMint", () => {
  const word = (hex: string) => `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const mint = (over: Partial<{ address: string; from: string; to: string; id: bigint }> = {}) => ({
    address: over.address ?? REGISTRY,
    topics: [
      TRANSFER_TOPIC,
      word(over.from ?? "0"),
      word(over.to ?? GUARDIAN),
      word((over.id ?? BigInt(LIVE_AGENT)).toString(16)),
    ],
  });
  const at = { registry: REGISTRY, owner: GUARDIAN };
  const unrelated = { address: ANOTHER_CONTRACT, topics: [`0x${"11".repeat(32)}`] };

  test("a register receipt gives the minted id", () => {
    expect(agentIdFromMint({ status: "success", logs: [unrelated, mint()] }, at)).toBe("897126");
  });

  test("addresses and topics in another case", () => {
    const loud = mint();
    const shouted = {
      address: lower(REGISTRY),
      topics: loud.topics.map((t) => `0x${t.slice(2).toUpperCase()}`),
    };
    expect(agentIdFromMint({ status: "success", logs: [shouted] }, { registry: REGISTRY, owner: lower(GUARDIAN) })).toBe(
      "897126",
    );
  });

  test("an id past 2^53 keeps every digit", () => {
    const big = BigInt("123456789012345678901234567890");
    expect(agentIdFromMint({ status: "success", logs: [mint({ id: big })] }, at)).toBe(
      "123456789012345678901234567890",
    );
  });

  test("a receipt that names no status is read by its logs", () => {
    expect(agentIdFromMint({ logs: [mint()] }, at)).toBe("897126");
  });

  test.each<[string, { status?: string; logs: { address: string; topics: string[] }[] }]>([
    ["a reverted receipt", { status: "reverted", logs: [mint()] }],
    ["a Transfer whose sender is not zero (not a mint)", { status: "success", logs: [mint({ from: OTHER_WALLET })] }],
    ["a Transfer from another contract", { status: "success", logs: [mint({ address: ANOTHER_CONTRACT })] }],
    ["a mint to another wallet", { status: "success", logs: [mint({ to: OTHER_WALLET })] }],
    ["two mints", { status: "success", logs: [mint(), mint({ id: BigInt(2) })] }],
    ["two mints, one to another wallet", { status: "success", logs: [mint(), mint({ to: OTHER_WALLET })] }],
    ["no logs", { status: "success", logs: [] }],
    ["another event", { status: "success", logs: [{ ...mint(), topics: [`0x${"22".repeat(32)}`, ...mint().topics.slice(1)] }] }],
    ["three topics", { status: "success", logs: [{ ...mint(), topics: mint().topics.slice(0, 3) }] }],
    [
      "a recipient word with bytes above the address",
      { status: "success", logs: [{ ...mint(), topics: [TRANSFER_TOPIC, word("0"), `0x${"ff".repeat(12)}${GUARDIAN.slice(2).toLowerCase()}`, word("1")] }] },
    ],
    [
      "an id that is not a word",
      { status: "success", logs: [{ ...mint(), topics: [TRANSFER_TOPIC, word("0"), word(GUARDIAN), "0x1"] }] },
    ],
  ])("null for %s", (_name, receipt) => {
    expect(agentIdFromMint(receipt, at)).toBeNull();
  });
});
