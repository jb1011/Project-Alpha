/**
 * The identity step's decisions, as tables: what a typed agent id and agent URI read as, which
 * identity a card lands on once the chain has said who owns it, what a reverted `ownerOf` means,
 * what a register receipt gives, and what the person reads when the wallet does not send.
 *
 * Nothing here reads a chain or a wallet: the chain's answers come in as values, and the viem
 * errors are built with viem's own classes and its own classifier, as a read or a send would
 * throw them.
 */
import {
  ContractFunctionExecutionError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  InsufficientFundsError,
  RpcRequestError,
  TimeoutError,
  UserRejectedRequestError,
  getContractError,
  maxUint256,
} from "viem";
import { describe, expect, test } from "vitest";
import type { Address, LegalBodyOrderView } from "@/lib/api/types";
import { TRANSFER_TOPIC, identityRegistryAbi } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";
import {
  REGISTER_RECEIPT_TIMEOUT_MS,
  cardOutcomeView,
  identityCardOutcome,
  identityChainOutcome,
  isRevert,
  parseAgentId,
  parseAgentUri,
  readOwnerOf,
  registerFailureLines,
  registerReceiptOutcome,
  registerRefusalSentence,
  registerSendFailure,
  registrationView,
  takenAgentIdOf,
  type IdentityCardOutcome,
} from "@/lib/legalBody/identity";

const I = LEGAL_BODY_COPY.identity;

/** Two of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** The public testnet identity registry and factory. */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
/** Inventions. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;
const AGENT = "897126";
const WHERE = { chainId: CHAIN, factory: FACTORY };
const lower = (a: Address) => a.toLowerCase() as Address;

/** 2^256, written out: one more than the largest uint256. */
const TWO_TO_256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639936";

const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "ord_0",
  publicId: "pub_0",
  companyId: "co_a",
  state: "linked",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"ab".repeat(32)}`, version: 1 },
  agentId: AGENT,
  identityOwner: GUARDIAN,
  bodyAddress: BODY,
  linkDeadline: 1_791_000_000,
  createTxHash: `0x${"cd".repeat(32)}`,
  deployedAt: 1_791_000_000,
  pointerSeenAt: 1_791_000_100,
  createdAt: "2026-10-12T11:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

// ---------------------------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------------------------

describe("parseAgentId: a canonical decimal uint256, trimmed", () => {
  test.each<[string, string, string]>([
    ["the live test identity", "897126", "897126"],
    ["spaces around it", " 897126 ", "897126"],
    ["a newline after a paste", "897126\n", "897126"],
    ["zero", "0", "0"],
    ["the largest uint256", maxUint256.toString(), maxUint256.toString()],
  ])("accepts %s", (_name, input, expected) => {
    expect(parseAgentId(input)).toBe(expected);
  });

  test.each<[string, string]>([
    ["a leading zero", "0897126"],
    ["a sign", "-1"],
    ["a plus sign", "+1"],
    ["an exponent", "1e3"],
    ["a decimal point", "1.0"],
    ["hex", "0x1f"],
    ["a space inside", "897 126"],
    ["79 digits", "1".repeat(79)],
    ["2^256", TWO_TO_256],
    ["nothing", ""],
    ["spaces only", "   "],
  ])("refuses %s", (_name, input) => {
    expect(parseAgentId(input)).toBeNull();
  });
});

describe("parseAgentUri: optional, https only, at most 2048 characters", () => {
  const https = (length: number) => {
    const head = "https://example.com/";
    return head + "a".repeat(length - head.length);
  };

  test.each<[string, string, string | null]>([
    ["nothing: no URI", "", null],
    ["spaces only: no URI", "   ", null],
    ["an https address", "https://example.com/agent.json", "https://example.com/agent.json"],
    ["an https address with spaces around it", "  https://example.com/agent.json\n", "https://example.com/agent.json"],
    ["the scheme in capitals", "HTTPS://example.com/agent.json", "HTTPS://example.com/agent.json"],
    ["exactly 2048 characters", https(2048), https(2048)],
  ])("accepts %s", (_name, input, expected) => {
    expect(parseAgentUri(input)).toBe(expected);
  });

  test.each<[string, string, string]>([
    ["http", "http://example.com/agent.json", I.uriProblems.https],
    ["another scheme", "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", I.uriProblems.https],
    ["no scheme", "example.com/agent.json", I.uriProblems.https],
    ["a scheme and no host", "https://", I.uriProblems.https],
    ["2049 characters", https(2049), I.uriProblems.length],
    ["a space inside", "https://example.com/my agent.json", I.uriProblems.characters],
    ["a tab inside, which a URL parser would drop silently", "https://exa\tmple.com/agent.json", I.uriProblems.characters],
    ["a zero-width character", "https://example.com/\u200bagent.json", I.uriProblems.characters],
  ])("refuses %s", (_name, input, problem) => {
    expect(parseAgentUri(input)).toStrictEqual({ problem });
  });
});

// ---------------------------------------------------------------------------------------------
// Which identity a card lands on
// ---------------------------------------------------------------------------------------------

describe("identityCardOutcome: the chain's owner and the tenant's orders decide", () => {
  type Input = Parameters<typeof identityCardOutcome>[0];
  const input = (over: Partial<Input> = {}): Input => ({
    card: "this-wallet",
    agentId: AGENT,
    ownerOf: GUARDIAN,
    connected: GUARDIAN,
    orders: [],
    where: WHERE,
    ...over,
  });

  const rows: [string, Input, IdentityCardOutcome][] = [
    // Taken wins over everything.
    ["a linked body for it: taken, on this wallet's card", input({ orders: [order()] }), { kind: "taken" }],
    [
      "a linked body for it: taken, on the other key's card",
      input({ card: "elsewhere", ownerOf: OTHER_KEY, orders: [order()] }),
      { kind: "taken" },
    ],
    [
      "a reserved order for it: taken, even though the chain says no identity",
      input({ ownerOf: "none", orders: [order({ state: "reserved", bodyAddress: null })] }),
      { kind: "taken" },
    ],
    [
      "a deployed body for it: taken, whoever owns it now",
      input({ ownerOf: OTHER_KEY, orders: [order({ state: "deployed", pointerSeenAt: null })] }),
      { kind: "taken" },
    ],
    [
      "a live body whose pointer was cleared: taken",
      input({ orders: [order({ state: "broken", brokenReason: "not_linked" })] }),
      { kind: "taken" },
    ],
    [
      "a revoked body whose pointer was cleared: not taken",
      input({ orders: [order({ state: "broken", brokenReason: "not_linked", revoked: true })] }),
      { kind: "this_wallet" },
    ],
    [
      "a body replaced by a newer one: not taken",
      input({ orders: [order({ state: "broken", brokenReason: "replaced", replacedBy: "ord_9" })] }),
      { kind: "this_wallet" },
    ],
    [
      "an order on another chain does not count as taken",
      input({ orders: [order({ chainId: 5042 })] }),
      { kind: "this_wallet" },
    ],
    [
      "an order under another factory does not count as taken",
      input({ orders: [order({ factory: ANOTHER_FACTORY })] }),
      { kind: "this_wallet" },
    ],
    [
      "another identity's linked body does not count",
      input({ orders: [order({ agentId: "7" })] }),
      { kind: "this_wallet" },
    ],
    [
      "a lapsed reservation for it does not count",
      input({ orders: [order({ state: "lapsed", bodyAddress: null, lapseReason: "deadline_passed" })] }),
      { kind: "this_wallet" },
    ],
    // No such identity.
    ["the read reverted: no identity, on this wallet's card", input({ ownerOf: "none" }), { kind: "no_identity" }],
    [
      "the read reverted: no identity, on the other key's card",
      input({ card: "elsewhere", ownerOf: "none" }),
      { kind: "no_identity" },
    ],
    // This wallet.
    ["owned by this wallet", input(), { kind: "this_wallet" }],
    [
      "owned by this wallet, the session address in lower case",
      input({ connected: lower(GUARDIAN) }),
      { kind: "this_wallet" },
    ],
    [
      "owned by this wallet, picked on the other key's card",
      input({ card: "elsewhere" }),
      { kind: "this_wallet" },
    ],
    // Another key, named.
    [
      "owned by another key, on this wallet's card: elsewhere with the owner",
      input({ ownerOf: OTHER_KEY }),
      { kind: "elsewhere", owner: OTHER_KEY },
    ],
    [
      "owned by another key, on the other key's card: elsewhere with the owner",
      input({ card: "elsewhere", ownerOf: OTHER_KEY }),
      { kind: "elsewhere", owner: OTHER_KEY },
    ],
  ];

  test.each(rows)("%s", (_name, given, expected) => {
    expect(identityCardOutcome(given)).toStrictEqual(expected);
  });
});

describe("identityChainOutcome: a deployment on a chain this site does not read", () => {
  test("the deployment's chain is the site's: nothing to say", () => {
    expect(identityChainOutcome(CHAIN, [CHAIN])).toBeNull();
  });

  test("another chain: no read and no registration here", () => {
    expect(identityChainOutcome(5042, [CHAIN])).toStrictEqual({ kind: "other_chain" });
  });
});

describe("cardOutcomeView: what the person reads, and what a pick writes", () => {
  type View = ReturnType<typeof cardOutcomeView>;
  const at = { agentId: AGENT, environment: "sandbox" as const };

  test("this wallet's identity on this wallet's card: picked at once, nothing to read", () => {
    const view = cardOutcomeView({ ...at, card: "this-wallet", outcome: { kind: "this_wallet" } });
    expect(view).toStrictEqual<View>({
      tone: "info",
      title: null,
      text: fillCopy(I.ownedHere, { agentId: AGENT }),
      pick: { ownerChoice: "this-wallet", agentId: AGENT },
      auto: true,
      toThirdCard: false,
    });
  });

  test("this wallet's identity on the other key's card: said, then continued as this wallet", () => {
    const view = cardOutcomeView({ ...at, card: "elsewhere", outcome: { kind: "this_wallet" } });
    expect(view.text).toBe(fillCopy(I.ownedHere, { agentId: AGENT }));
    expect(view.pick).toStrictEqual({ ownerChoice: "this-wallet", agentId: AGENT });
    expect(view.auto).toBe(false);
  });

  test("another key's identity on this wallet's card: the owner named, and the third card offered", () => {
    const view = cardOutcomeView({
      ...at,
      card: "this-wallet",
      outcome: { kind: "elsewhere", owner: OTHER_KEY },
    });
    expect(view.tone).toBe("warn");
    expect(view.text).toBe(fillCopy(I.notThisWallet, { agentId: AGENT, owner: OTHER_KEY }));
    expect(view.text).toContain(OTHER_KEY);
    expect(view.pick).toBeNull();
    expect(view.toThirdCard).toBe(true);
  });

  test("another key's identity on the other key's card: the owner named, continued as elsewhere", () => {
    const view = cardOutcomeView({
      ...at,
      card: "elsewhere",
      outcome: { kind: "elsewhere", owner: OTHER_KEY },
    });
    expect(view.tone).toBe("info");
    expect(view.text).toBe(fillCopy(I.ownedElsewhere, { agentId: AGENT, owner: OTHER_KEY }));
    expect(view.pick).toStrictEqual({ ownerChoice: "elsewhere", agentId: AGENT });
    expect(view.auto).toBe(false);
    expect(view.toThirdCard).toBe(false);
  });

  test.each(["this-wallet", "elsewhere"] as const)("taken on the %s card: the refusal, and no pick", (card) => {
    const view = cardOutcomeView({ ...at, card, outcome: { kind: "taken" } });
    expect(view.tone).toBe("warn");
    expect(view.title).toBe(LEGAL_BODY_COPY.notices.identity_taken.title);
    expect(view.text).toContain(I.taken);
    expect(view.text).toContain(AGENT);
    expect(view.pick).toBeNull();
  });

  test("no identity: said with the network, and no pick", () => {
    const view = cardOutcomeView({ ...at, card: "this-wallet", outcome: { kind: "no_identity" } });
    expect(view.text).toBe(fillCopy(I.noIdentity, { agentId: AGENT, network: "Arc testnet" }));
    expect(view.pick).toBeNull();
  });

  test("another chain: said with the network this site reads, and no pick", () => {
    const view = cardOutcomeView({
      agentId: AGENT,
      environment: "production",
      card: "elsewhere",
      outcome: { kind: "other_chain" },
    });
    expect(view.text).toBe(fillCopy(I.otherChain, { network: "Arc" }));
    expect(view.pick).toBeNull();
  });
});

describe("takenAgentIdOf: the identity the memory forgets once the refusal is on screen", () => {
  test.each<[string, LegalBodyDerivation, string | null]>([
    ["the refusal", { phase: "identity", notice: { kind: "identity_taken", agentId: AGENT } }, AGENT],
    ["the identity step with no notice", { phase: "identity" }, null],
    ["another notice", { phase: "link", branch: "browser", notice: { kind: "creating" } }, null],
  ])("%s", (_name, derivation, expected) => {
    expect(takenAgentIdOf(derivation)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Reading the owner: a revert is "no identity", anything else is "could not read"
// ---------------------------------------------------------------------------------------------

/** What `readContract` throws for `ownerOf(42)`, built by viem's own classifier. */
function readError(cause: Error): Error {
  return getContractError(cause as never, {
    abi: identityRegistryAbi,
    functionName: "ownerOf",
    args: [BigInt(42)],
    address: REGISTRY,
  });
}

const rpc = (code: number, message: string, data?: string) =>
  new RpcRequestError({
    body: { method: "eth_call" },
    error: { code, message, data },
    url: "https://rpc.example",
  });

/** ERC721NonexistentToken(42), as a registry answers `ownerOf` for an id never minted. */
const NONEXISTENT = `0x7e273289${(42).toString(16).padStart(64, "0")}`;

describe("isRevert: only the chain saying the call reverted", () => {
  test.each<[string, unknown, boolean]>([
    ["an execution revert with its data", readError(rpc(3, "execution reverted", NONEXISTENT)), true],
    ["the older revert answer (-32000)", readError(rpc(-32000, "execution reverted", NONEXISTENT)), true],
    ["an internal error that says it reverted", readError(rpc(-32603, "execution reverted")), true],
    [
      "an internal error that does not say it reverted (viem reads it as a revert)",
      readError(rpc(-32603, "internal error")),
      false,
    ],
    ["an HTTP failure", readError(new HttpRequestError({ url: "https://rpc.example", status: 502 })), false],
    ["a timeout", readError(new TimeoutError({ body: {}, url: "https://rpc.example" })), false],
    [
      "no contract at the address",
      new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "ownerOf" }), {
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [BigInt(42)],
      }),
      false,
    ],
    ["a plain error", new Error("boom"), false],
    ["a string", "boom", false],
    ["nothing", undefined, false],
  ])("%s", (_name, e, expected) => {
    expect(isRevert(e)).toBe(expected);
  });

  test("the viem classifier does read the internal error as a revert, so the guard is ours", () => {
    const e = readError(rpc(-32603, "internal error")) as ContractFunctionExecutionError;
    expect(e.cause?.name).toBe("ContractFunctionRevertedError");
  });

  test("a cause chain that loops ends", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    a.cause = a;
    expect(isRevert(a)).toBe(false);
  });
});

describe("readOwnerOf", () => {
  const answers = (value: unknown) => async () => value;
  const throws = (e: unknown) => async () => {
    throw e;
  };

  test.each<[string, () => Promise<unknown>, Address | "none" | "unreadable"]>([
    ["an owner", answers(GUARDIAN), GUARDIAN],
    ["an owner in lower case", answers(lower(GUARDIAN)), lower(GUARDIAN)],
    ["the zero address: nobody owns it", answers("0x0000000000000000000000000000000000000000"), "none"],
    ["a revert: no identity with this id", throws(readError(rpc(3, "execution reverted", NONEXISTENT))), "none"],
    [
      "an HTTP failure: unread, never no identity",
      throws(readError(new HttpRequestError({ url: "https://rpc.example", status: 502 }))),
      "unreadable",
    ],
    ["an internal error with no revert in it: unread", throws(readError(rpc(-32603, "internal error"))), "unreadable"],
    ["an answer that is not an address", answers("0x1234"), "unreadable"],
    ["an answer that is not a string", answers(42), "unreadable"],
  ])("%s", async (_name, read, expected) => {
    expect(await readOwnerOf(read)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Registering a new identity
// ---------------------------------------------------------------------------------------------

describe("the register receipt", () => {
  test("waits three minutes", () => {
    expect(REGISTER_RECEIPT_TIMEOUT_MS).toBe(180_000);
  });

  const word = (hex: string) => `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const mint = (to: string = GUARDIAN, id: string = AGENT) => ({
    address: REGISTRY,
    topics: [TRANSFER_TOPIC, word("0"), word(to), word(BigInt(id).toString(16))],
  });
  const at = { registry: REGISTRY, owner: GUARDIAN };

  test.each<[string, { status: "success" | "reverted"; logs: { address: string; topics: string[] }[] }, ReturnType<typeof registerReceiptOutcome>]>([
    ["a mint to this wallet: the id", { status: "success", logs: [mint()] }, { kind: "registered", agentId: AGENT }],
    ["a reverted transaction: nothing registered", { status: "reverted", logs: [] }, { kind: "reverted" }],
    ["a receipt with no mint: unreadable", { status: "success", logs: [] }, { kind: "unreadable" }],
    ["a mint to another wallet: unreadable", { status: "success", logs: [mint(OTHER_KEY)] }, { kind: "unreadable" }],
    ["two mints: unreadable", { status: "success", logs: [mint(), mint(GUARDIAN, "7")] }, { kind: "unreadable" }],
  ])("%s", (_name, receipt, expected) => {
    expect(registerReceiptOutcome(receipt, at)).toStrictEqual(expected);
  });
});

describe("registrationView: the sentence for each stage after the send", () => {
  test("waiting: the sentence and the transaction, no field", () => {
    expect(registrationView("waiting")).toStrictEqual({ text: I.waiting, tone: "info", manualEntry: false });
  });

  test("a receipt that names no id: its sentence, and a field for the id", () => {
    expect(registrationView("unreadable")).toStrictEqual({
      text: I.receiptUnreadable,
      tone: "warn",
      manualEntry: true,
    });
  });

  test("no receipt in time: said, and a field for the id", () => {
    expect(registrationView("no_receipt")).toStrictEqual({ text: I.noReceipt, tone: "warn", manualEntry: true });
  });

  test("a reverted transaction: nothing registered, and no field", () => {
    expect(registrationView("reverted")).toStrictEqual({ text: I.reverted, tone: "warn", manualEntry: false });
  });
});

/** What `writeContract` throws, built by viem's own classifier. */
function sendError(cause: Error): Error {
  return getContractError(cause as never, {
    abi: identityRegistryAbi,
    functionName: "register",
    args: [],
    address: REGISTRY,
    sender: GUARDIAN,
  });
}

/** An EIP-1193 provider error, as a wallet raises it. */
const providerError = (code: number, message: string) => Object.assign(new Error(message), { code });

describe("registerSendFailure: a wallet's no, or a wallet that cannot send", () => {
  test.each<[string, unknown, ReturnType<typeof registerSendFailure>]>([
    [
      "a wallet's no, in its own words",
      sendError(new UserRejectedRequestError(providerError(4001, "User denied transaction signature."))),
      { kind: "rejected", message: "User denied transaction signature." },
    ],
    [
      "a wallet's no with no words of its own: viem's",
      sendError(new UserRejectedRequestError(new Error(""))),
      { kind: "rejected", message: "User rejected the request." },
    ],
    [
      "a provider's no, not wrapped",
      { code: 4001, message: "Request rejected" },
      { kind: "rejected", message: "Request rejected" },
    ],
    [
      "a no on several lines: the first, squeezed",
      providerError(4001, "  The user   rejected\nthe request, details follow  "),
      { kind: "rejected", message: "The user rejected" },
    ],
    ["a no with no words at all", { code: 4001 }, { kind: "rejected", message: null }],
    [
      "an HTTP failure",
      sendError(new HttpRequestError({ url: "https://rpc.example", status: 502 })),
      { kind: "cannot_send" },
    ],
    ["a method the wallet does not support", sendError(providerError(4200, "Method not supported")), { kind: "cannot_send" }],
    ["a plain error", new Error("Connector not connected."), { kind: "cannot_send" }],
    ["a string", "boom", { kind: "cannot_send" }],
    ["too little native USDC for the gas, as viem says it", new InsufficientFundsError(), { kind: "no_gas" }],
    [
      "too little native USDC for the gas, deep in the cause chain",
      { name: "TransactionExecutionError", shortMessage: "Execution failed.", cause: sendError(new InsufficientFundsError()) },
      { kind: "no_gas" },
    ],
    [
      "a wallet's no stays the wallet's no, whatever lies under it",
      Object.assign(new Error("User rejected the request."), { code: 4001, cause: new InsufficientFundsError() }),
      { kind: "rejected", message: "User rejected the request." },
    ],
  ])("%s", (_name, e, expected) => {
    expect(registerSendFailure(e)).toStrictEqual(expected);
  });

  test("a wallet's long message is cut short", () => {
    const failure = registerSendFailure(providerError(4001, "x".repeat(500)));
    expect(failure.kind === "rejected" && failure.message?.length).toBe(200);
  });
});

describe("registerFailureLines", () => {
  test("a wallet's no: its message, after the sentence that nothing was registered", () => {
    expect(registerFailureLines({ kind: "rejected", message: "User denied transaction signature." }, "sandbox")).toStrictEqual([
      fillCopy(I.rejected, { message: "User denied transaction signature." }),
    ]);
  });

  test("a no with no words: the sentence alone", () => {
    expect(registerFailureLines({ kind: "rejected", message: null }, "sandbox")).toStrictEqual([I.rejectedNoWords]);
  });

  test("any other failure: the plain cannot-send sentence, then the way on", () => {
    const lines = registerFailureLines({ kind: "cannot_send" }, "sandbox");
    expect(lines[0]).toBe(LEGAL_BODY_COPY.pointer.cannotSend);
    expect(lines[0].startsWith("Your wallet can sign but it cannot send a transaction on Arc")).toBe(true);
    expect(lines).toStrictEqual([LEGAL_BODY_COPY.pointer.cannotSend, I.cannotSendWayOut]);
  });

  test.each([
    ["sandbox", LEGAL_BODY_COPY.pointer.gas],
    ["production", LEGAL_BODY_COPY.pointer.gasProduction],
  ] as const)("too little gas on %s: the gas sentence, never the cannot-send one", (environment, sentence) => {
    const lines = registerFailureLines({ kind: "no_gas" }, environment);
    expect(lines).toStrictEqual([sentence]);
    expect(lines).not.toContain(LEGAL_BODY_COPY.pointer.cannotSend);
  });

  test("on the testnet the gas sentence names the faucet", () => {
    expect(registerFailureLines({ kind: "no_gas" }, "sandbox")[0]).toContain("faucet");
  });
});

describe("registerRefusalSentence: the allowlist or the chain check refused before the wallet", () => {
  test("a wallet on another network: switch it there", () => {
    expect(registerRefusalSentence("wallet_on_another_chain", "sandbox")).toBe(
      fillCopy(I.otherNetwork, { network: "Arc testnet" }),
    );
  });

  test("a deployment on a chain this site does not read", () => {
    expect(registerRefusalSentence("chain_not_configured", "production")).toBe(
      fillCopy(I.otherChain, { network: "Arc" }),
    );
  });

  test("anything else: refused before the wallet, with the problem word", () => {
    expect(registerRefusalSentence("not_the_registry", "sandbox")).toBe(
      fillCopy(I.refusedBeforeWallet, { problem: "not_the_registry" }),
    );
  });
});
