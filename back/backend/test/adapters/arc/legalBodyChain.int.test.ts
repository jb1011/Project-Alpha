/**
 * THE LEGAL-BODY CREATE AGAINST REAL CONTRACTS, on a local anvil.
 *
 * The real NoviController checks the executor's grant and the selector's pin and forwards the call
 * to the real LegalBodyFactory, which reads the identity's owner from the registry, checks the
 * owner's signature and deploys the body. Every other test of this path fakes the node or the
 * controller; this one fakes neither.
 *
 * Owners are a key, a plain contract wallet (`MockERC1271Wallet`), and a policy wallet
 * (`MockPolicyWallet`) whose signature check can approve a digest for an empty signature, check a
 * wrapped digest, or spend a set amount of gas.
 *
 * One chain and one stack for the whole file, deployed once in `beforeAll`. Every case registers
 * its own identity and signs its own link, so the cases share nothing but the contracts. A case
 * that changes a controller grant or switches automine off puts it back before it ends.
 */
import {
  http,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type TestClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbi,
  parseEventLogs,
  parseSignature,
  serializeCompactSignature,
  signatureToCompactSignature,
  stringToHex,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  iIdentityRegistryAbi,
  legalManagerAbi,
  mockIdentityRegistryAbi,
} from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { assertLegalBodyFactoryWiring } from "../../../src/adapters/arc/bootVerify";
import {
  CREATE_GAS_CEILING,
  CREATE_GAS_HEADROOM_PERCENT,
  CREATE_MAX_FEE_WEI,
  LegalBodyChain,
  LegalBodyChainFaultError,
  type LegalBodyCreated,
  LegalBodyGasTooHighError,
  type SubmitCreateResult,
} from "../../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../../src/adapters/arc/relay";
import { anvilChain } from "../../../src/chains";
import { type LinkCheck, checkLink } from "../../../src/legalBody/checkLink";
import {
  type LegalBodyLink,
  buildLinkTypedData,
  linkDeadline,
  linkFromWire,
  linkTypedDataWire,
  offChainLinkDigest,
} from "../../../src/legalBody/link";
import { type AnvilHandle, startAnvil } from "../../helpers/anvil";
import {
  LEGAL_BODY_FACTORY_SELECTORS,
  type LegalBodyStack,
  deployContract,
  deployLegalBodyStack,
  grantSelector,
  revokeSelector,
} from "../../helpers/legalBodyStack";

/** This file's own port: 8545–8552 belong to the other anvil-based files. */
const PORT = 8553;

/** anvil's published test keys (accounts #0 to #5): never real wallets. */
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
/** Signs and pays for every create: the backend's platform key. */
const executor = privateKeyToAccount(KEYS[0]);
/** The controller's role administrator. */
const admin = privateKeyToAccount(KEYS[1]);
/** The identity owner's key, and the signer of both contract wallets. */
const owner = privateKeyToAccount(KEYS[2]);
/** The tenant: every link names it as the body's guardian. */
const guardian = privateKeyToAccount(KEYS[3]).address;
/** A key that owns nothing here. */
const stranger = privateKeyToAccount(KEYS[4]);
/** Deploys the contracts, so the executor's nonce moves only for creates. */
const deployer = privateKeyToAccount(KEYS[5]);

/** The ArcAdapter's entity-factory address, a placeholder: the legal-body path never calls it. */
const UNUSED_ENTITY_FACTORY = "0x00000000000000000000000000000000000000f1" as Address;
const AGREEMENT_HASH = `0x${"ab".repeat(32)}` as Hex;
/** 48 hours: the factory's shortest amendment delay. */
const DELAY = 172_800n;
const expected = {
  tenant: guardian,
  operatingAgreementHash: AGREEMENT_HASH,
  amendmentDelay: DELAY,
};

/** `MockPolicyWallet.WRAP_TYPEHASH`, computed here from its type string. */
const WRAP_TYPEHASH = keccak256(stringToHex("Wrap(address account,bytes32 digest)"));
/** The gas `MockPolicyWallet` spends in its check, enough to put the create's estimate above the
 *  highest one the ceiling allows (the ceiling less its headroom, 480,000). */
const BURN_GAS = 550_000n;
/** ERC-1271's answer for a valid signature. */
const ERC1271_MAGIC = "0x1626ba7e";

const contractWalletAbi = parseAbi([
  "function execute(address target, bytes data) returns (bytes)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const policyWalletAbi = parseAbi([
  "function approve(bytes32 digest)",
  "function setBurn(uint256 gas_)",
  "function setWrap(bool on)",
]);
/** `MockERC1271Wallet`'s switch: when on, its check refuses every signature. */
const refusingWalletAbi = parseAbi(["function setRefuseAll(bool v)"]);

let anvil: AnvilHandle | undefined;
let pub: PublicClient;
let stack: LegalBodyStack;
let arc: ArcAdapter;
let lb: LegalBodyChain;

function walletOf(account: PrivateKeyAccount): WalletClient {
  if (!anvil) throw new Error("anvil is not running");
  return createWalletClient({ account, chain: anvilChain, transport: http(anvil.rpcUrl) });
}

beforeAll(async () => {
  anvil = await startAnvil(PORT);
  pub = createPublicClient({ chain: anvilChain, transport: http(anvil.rpcUrl) });
  stack = await deployLegalBodyStack({
    deployer: walletOf(deployer),
    admin: walletOf(admin),
    pub,
    executor: executor.address,
  });
  arc = new ArcAdapter({
    publicClient: pub,
    managerWallet: walletOf(executor),
    sendClient: pub,
    chainId: anvilChain.id,
    factory: UNUSED_ENTITY_FACTORY,
    identityRegistry: stack.registry,
    controller: stack.controller,
  });
  lb = new LegalBodyChain({
    publicClient: pub,
    arc,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
}, 60_000);

afterAll(() => anvil?.stop());

const linkContext = () => ({ chainId: anvilChain.id, factory: stack.factory });

/** Wait for a transaction and refuse a revert, so a failed setup step cannot pass for a refusal. */
async function mined(hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setup transaction ${hash} reverted`);
  return receipt;
}

/** The identity id the registry minted in this receipt. */
function mintedId(logs: Log[]): bigint {
  const minted = parseEventLogs({ abi: mockIdentityRegistryAbi, eventName: "Transfer", logs }).find(
    (l) => isAddressEqual(l.address, stack.registry),
  );
  if (!minted) throw new Error("the registry minted no identity");
  return minted.args.tokenId;
}

/** Register an identity owned by the key `account`. */
async function registerByKey(account: PrivateKeyAccount): Promise<bigint> {
  const hash = await walletOf(account).writeContract({
    address: stack.registry,
    abi: iIdentityRegistryAbi,
    functionName: "register",
    args: ["ipfs://legal-body-int"],
    account,
    chain: anvilChain,
  });
  return mintedId((await mined(hash)).logs);
}

/** Register an identity owned by the contract wallet `wallet`, through its signer's passthrough. */
async function registerByWallet(wallet: Address): Promise<bigint> {
  const hash = await walletOf(owner).writeContract({
    address: wallet,
    abi: contractWalletAbi,
    functionName: "execute",
    args: [
      stack.registry,
      encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "register",
        args: ["ipfs://legal-body-int"],
      }),
    ],
    account: owner,
    chain: anvilChain,
  });
  const agentId = mintedId((await mined(hash)).logs);
  expect(await lb.identityOwner(agentId)).toBe(wallet);
  return agentId;
}

/** A `MockPolicyWallet` whose signer is `owner`, with the behaviours `setup` switches on. */
async function policyWallet(setup: { wrap?: boolean; burnGas?: bigint } = {}): Promise<Address> {
  const wallet = await deployContract(walletOf(deployer), pub, "MockPolicyWallet", [owner.address]);
  if (setup.wrap) await asPolicySigner(wallet, "setWrap", [true]);
  if (setup.burnGas !== undefined) await asPolicySigner(wallet, "setBurn", [setup.burnGas]);
  return wallet;
}

async function asPolicySigner(
  wallet: Address,
  ...[functionName, args]:
    | ["setWrap", readonly [boolean]]
    | ["setBurn", readonly [bigint]]
    | ["approve", readonly [Hex]]
): Promise<void> {
  const hash = await walletOf(owner).writeContract({
    address: wallet,
    abi: policyWalletAbi,
    functionName,
    // biome-ignore lint/suspicious/noExplicitAny: three functions, three argument shapes
    args: args as any,
    account: owner,
    chain: anvilChain,
  });
  await mined(hash);
}

/** A link for `agentId` with a deadline served from the CHAIN's clock, not this machine's. */
async function newLink(agentId: bigint): Promise<LegalBodyLink> {
  const { timestamp } = await lb.head();
  return {
    agentId,
    guardian,
    amendmentDelay: DELAY,
    operatingAgreementHash: AGREEMENT_HASH,
    deadline: linkDeadline(timestamp),
  };
}

const signLink = (account: PrivateKeyAccount, link: LegalBodyLink) =>
  account.signTypedData(buildLinkTypedData({ ...linkContext(), link }));

type Accepted = Extract<LinkCheck, { ok: true }>;

function accepted(check: LinkCheck): Accepted {
  if (!check.ok) throw new Error(`expected the link to be accepted, got ${check.code}`);
  return check;
}

/** What a refusal carries once the link's identity, digest and body address are known. */
async function knownFacts(link: LegalBodyLink, identityOwner: Address) {
  const linkDigest = await lb.linkDigest(link);
  return { identityOwner, linkDigest, bodyAddress: await lb.predictLegalBody(linkDigest) };
}

/** The executor's mined and pending transaction counts. */
async function executorCounts() {
  return {
    mined: await lb.executorNonce(),
    pending: await pub.getTransactionCount({ address: executor.address, blockTag: "pending" }),
  };
}

/**
 * Create the body for an accepted link the way a caller does: `submitCreate` with a `record` that
 * keeps what it is handed, then `confirmCreate`. Checks that what was recorded is what was sent,
 * and that the chain names the body at the address the check predicted.
 */
async function createAccepted(
  link: LegalBodyLink,
  check: Accepted,
): Promise<{ txHash: Hex; created: LegalBodyCreated }> {
  const recorded: { txHash: Hex; rawTx: Hex; nonce: number }[] = [];
  const sent = await lb.submitCreate({
    link,
    signature: check.signature,
    record: (signed) => {
      recorded.push(signed);
      return true;
    },
  });
  if (sent.status !== "sent") throw new Error(`expected the create to be sent, got ${sent.status}`);
  expect(recorded).toEqual([{ txHash: sent.txHash, rawTx: sent.rawTx, nonce: sent.nonce }]);

  const created = await lb.confirmCreate(sent.txHash, { bodyAddress: check.bodyAddress });
  expect(created).toMatchObject({
    legalBody: check.bodyAddress,
    agentId: link.agentId,
    identityOwner: check.identityOwner,
    guardian,
    linkDigest: check.linkDigest,
    txHash: sent.txHash,
  });
  await expect(
    lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: check.identityOwner }),
  ).resolves.toBe("created");
  return { txHash: sent.txHash, created };
}

/** The same signature with its last byte replaced by the raw recovery bit (0 or 1). */
function withRecoveryBit(signature: Hex): Hex {
  const { yParity } = parseSignature(signature);
  return `${signature.slice(0, 130)}0${yParity}` as Hex;
}

/** The same signature in its 64-byte EIP-2098 compact form. */
function compact(signature: Hex): Hex {
  return serializeCompactSignature(signatureToCompactSignature(parseSignature(signature)));
}

/** The secp256k1 group order, written out here. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The same signature with `s` replaced by its high twin `n - s` and the recovery bit flipped. */
function highS(signature: Hex): Hex {
  const { r, s, yParity } = parseSignature(signature);
  const twin = numberToHex(SECP256K1_N - hexToBigInt(s), { size: 32 });
  return `${r}${twin.slice(2)}${yParity === 0 ? "1c" : "1b"}` as Hex;
}

describe("the create, relayed through the real controller to the real factory", () => {
  test("the boot-time wiring check passes: the controller owns the factory, which reads this registry and signs for this chain, and both factory selectors are pinned to it and granted to the executor", async () => {
    await expect(
      assertLegalBodyFactoryWiring(pub, {
        factory: stack.factory,
        controller: stack.controller,
        identityRegistry: stack.registry,
        executor: executor.address,
        chainId: anvilChain.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("the off-chain digest, the digest a wallet signs from the wire form, and the digest of the link parsed back from the wire all equal the factory's linkDigest", async () => {
    const link = await newLink(await registerByKey(owner));
    const factoryDigest = await lb.linkDigest(link);

    expect(offChainLinkDigest({ ...linkContext(), link })).toBe(factoryDigest);

    const wire = JSON.parse(JSON.stringify(linkTypedDataWire({ ...linkContext(), link })));
    expect(hashTypedData(wire)).toBe(factoryDigest);

    const parsed = linkFromWire(wire.message);
    expect(parsed).toEqual(link);
    expect(offChainLinkDigest({ ...linkContext(), link: parsed })).toBe(factoryDigest);
    await expect(lb.linkDigest(parsed)).resolves.toBe(factoryDigest);
  });

  test("a key owner: the link is accepted, the create is recorded then sent, the controller relays it, and the agent is linked once the owner writes the pointer", async () => {
    const agentId = await registerByKey(owner);
    // The owner signs the wire form as it arrives, and the link is read back from it.
    const wire = JSON.parse(
      JSON.stringify(linkTypedDataWire({ ...linkContext(), link: await newLink(agentId) })),
    );
    const signature = await owner.signTypedData(wire);
    const link = linkFromWire(wire.message);

    const check = accepted(await checkLink(lb, { link, signature, expected }));
    expect(check).toMatchObject({
      ...(await knownFacts(link, owner.address)),
      signature,
    });
    expect(check.gasLimit).toBeLessThanOrEqual(CREATE_GAS_CEILING);
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("absent");

    const before = await executorCounts();
    const order: string[] = [];
    const realSend = arc.sendRawRelayedCall.bind(arc);
    const sendSpy = vi.spyOn(arc, "sendRawRelayedCall").mockImplementation(async (rawTx) => {
      order.push("send");
      return realSend(rawTx);
    });
    let sent: Awaited<ReturnType<LegalBodyChain["submitCreate"]>>;
    try {
      sent = await lb.submitCreate({
        link,
        signature: check.signature,
        record: () => {
          order.push("record");
          return true;
        },
      });
    } finally {
      sendSpy.mockRestore();
    }
    expect(order).toEqual(["record", "send"]);
    if (sent.status !== "sent")
      throw new Error(`expected the create to be sent, got ${sent.status}`);
    expect(sent.nonce).toBe(before.pending);

    const created = await lb.confirmCreate(sent.txHash, { bodyAddress: check.bodyAddress });
    expect(created).toMatchObject({
      legalBody: check.bodyAddress,
      agentId,
      identityOwner: owner.address,
      guardian,
      linkDigest: check.linkDigest,
      txHash: sent.txHash,
    });

    const receipt = await pub.getTransactionReceipt({ hash: sent.txHash });
    expect(isAddressEqual(receipt.from, executor.address)).toBe(true);
    expect(receipt.to && isAddressEqual(receipt.to, stack.controller)).toBe(true);
    expect(receipt.gasUsed).toBeLessThan(check.gasLimit);
    const tx = await pub.getTransaction({ hash: sent.txHash });
    expect(tx.gas).toBeLessThanOrEqual(CREATE_GAS_CEILING);
    expect(receipt.gasUsed).toBeLessThan(tx.gas);
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("created");

    // The body's manager is the factory, read from the body itself.
    await expect(
      pub.readContract({
        address: created.legalBody,
        abi: legalManagerAbi,
        functionName: "manager",
      }),
    ).resolves.toBe(stack.factory);
    await expect(
      pub.readContract({
        address: created.legalBody,
        abi: legalManagerAbi,
        functionName: "guardian",
      }),
    ).resolves.toBe(guardian);

    // Not linked until the OWNER writes the pointer in its own identity's metadata.
    await expect(lb.linkedLegalBody(agentId)).resolves.toBeUndefined();
    const pointer = await lb.encodePointer(created.legalBody);
    await mined(
      await walletOf(owner).writeContract({
        address: stack.registry,
        abi: iIdentityRegistryAbi,
        functionName: "setMetadata",
        args: [agentId, "legalBody", pointer],
        account: owner,
        chain: anvilChain,
      }),
    );
    await expect(lb.linkedLegalBody(agentId)).resolves.toBe(created.legalBody);
  });

  test("a contract owner is accepted through its own ERC-1271 check", async () => {
    const wallet = await deployContract(walletOf(deployer), pub, "MockERC1271Wallet", [
      owner.address,
    ]);
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const signature = await signLink(owner, link);
    const facts = await knownFacts(link, wallet);

    // The signature is the wallet signer's, not a key for the wallet's address: only the wallet's
    // own check can vouch for it.
    await expect(
      pub.readContract({
        address: wallet,
        abi: contractWalletAbi,
        functionName: "isValidSignature",
        args: [facts.linkDigest, signature],
      }),
    ).resolves.toBe(ERC1271_MAGIC);

    const check = accepted(await checkLink(lb, { link, signature, expected }));
    expect(check).toMatchObject({ ...facts, signature });
    const { created } = await createAccepted(link, check);
    expect(created.identityOwner).toBe(wallet);
  });

  test("a contract owner that checks a wrapped digest: a signature over the wrapped hash is accepted, and one over the plain digest is bad_signature", async () => {
    const wallet = await policyWallet({ wrap: true });
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const facts = await knownFacts(link, wallet);
    const wrapped = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
        [WRAP_TYPEHASH, wallet, facts.linkDigest],
      ),
    );

    await expect(
      checkLink(lb, { link, signature: await signLink(owner, link), expected }),
    ).resolves.toEqual({ ok: false, code: "bad_signature", ...facts });

    const wrappedSignature = await owner.sign({ hash: wrapped });
    const check = accepted(await checkLink(lb, { link, signature: wrappedSignature, expected }));
    expect(check).toMatchObject({ ...facts, signature: wrappedSignature });
    await createAccepted(link, check);
  });

  test("a contract owner that refuses a stranger's signature: bad_signature, decided by the simulation of the relayed create", async () => {
    const wallet = await deployContract(walletOf(deployer), pub, "MockERC1271Wallet", [
      owner.address,
    ]);
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const signature = await signLink(stranger, link);

    const simulate = vi.spyOn(arc, "estimateRelayedCall");
    let result: LinkCheck;
    let simulations: number;
    try {
      result = await checkLink(lb, { link, signature, expected });
      simulations = simulate.mock.calls.length;
    } finally {
      simulate.mockRestore();
    }
    expect(result).toEqual({
      ok: false,
      code: "bad_signature",
      ...(await knownFacts(link, wallet)),
    });
    expect(simulations).toBe(1);

    // The verdict is the contract's: the relayed create itself reverts with the factory's error.
    const refusal = await lb.estimateCreate(link, signature).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContractRevertError);
    expect((refusal as ContractRevertError).errorName).toBe("BadSignature");
  });

  test("four encodings of the key owner's signature (v 27/28, v 0/1, EIP-2098, high s) come back as the same canonical signature, and one create is made with it", async () => {
    const agentId = await registerByKey(owner);
    const link = await newLink(agentId);
    const canonical = await signLink(owner, link);
    const encodings = [canonical, withRecoveryBit(canonical), compact(canonical), highS(canonical)];
    expect(new Set(encodings).size).toBe(4);

    // The factory itself accepts only the canonical form.
    for (const other of encodings.slice(1)) {
      const refusal = await lb.estimateCreate(link, other).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ContractRevertError);
      expect((refusal as ContractRevertError).errorName).toBe("BadSignature");
    }

    const checks: Accepted[] = [];
    for (const signature of encodings)
      checks.push(accepted(await checkLink(lb, { link, signature, expected })));
    expect(checks.map((c) => c.signature)).toEqual([canonical, canonical, canonical, canonical]);
    expect(new Set(checks.map((c) => c.bodyAddress)).size).toBe(1);

    const { created } = await createAccepted(link, checks[3]!);
    expect(created.identityOwner).toBe(owner.address);
  });

  test("an empty signature on a digest the contract owner approved is accepted", async () => {
    const wallet = await policyWallet();
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const facts = await knownFacts(link, wallet);

    // Before the approval, the same empty signature is refused.
    await expect(checkLink(lb, { link, signature: "0x", expected })).resolves.toEqual({
      ok: false,
      code: "bad_signature",
      ...facts,
    });

    await asPolicySigner(wallet, "approve", [facts.linkDigest]);
    const check = accepted(await checkLink(lb, { link, signature: "0x", expected }));
    expect(check).toMatchObject({ ...facts, signature: "0x" });
    const { created } = await createAccepted(link, check);
    expect(created.identityOwner).toBe(wallet);
  });

  test("gas_too_high for real: an owner whose check burns gas past the ceiling is refused with the estimate, and nothing is sent", async () => {
    const wallet = await policyWallet({ burnGas: BURN_GAS });
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const signature = await signLink(owner, link);
    const before = await executorCounts();

    const result = await checkLink(lb, { link, signature, expected });
    expect(result).toMatchObject({
      ok: false,
      code: "gas_too_high",
      ...(await knownFacts(link, wallet)),
    });
    const estimate = (result as { gasEstimate?: bigint }).gasEstimate;
    if (estimate === undefined) throw new Error("the refusal carries no estimate");
    expect(estimate).toBeGreaterThan(BURN_GAS);
    expect(estimate + (estimate * CREATE_GAS_HEADROOM_PERCENT) / 100n).toBeGreaterThan(
      CREATE_GAS_CEILING,
    );

    // The create path refuses before anything is signed or recorded.
    let recordCalls = 0;
    const refusal = await lb
      .submitCreate({
        link,
        signature,
        record: () => {
          recordCalls++;
          return true;
        },
      })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(LegalBodyGasTooHighError);
    expect((refusal as LegalBodyGasTooHighError).estimate).toBeGreaterThan(BURN_GAS);
    expect(recordCalls).toBe(0);
    expect(await executorCounts()).toEqual(before);

    // The gas was the only objection: with the burn off, the same link is accepted.
    await asPolicySigner(wallet, "setBurn", [0n]);
    accepted(await checkLink(lb, { link, signature, expected }));
  });

  test("an identity that does not exist answers identity_not_found", async () => {
    const link = await newLink(999_999n);
    await expect(
      checkLink(lb, { link, signature: await signLink(owner, link), expected }),
    ).resolves.toEqual({ ok: false, code: "identity_not_found" });
  });

  test("a link signed before the identity changed hands answers bad_signature", async () => {
    const agentId = await registerByKey(owner);
    const link = await newLink(agentId);
    const signature = await signLink(owner, link);
    await mined(
      await walletOf(owner).writeContract({
        address: stack.registry,
        abi: iIdentityRegistryAbi,
        functionName: "transferFrom",
        args: [owner.address, stranger.address, agentId],
        account: owner,
        chain: anvilChain,
      }),
    );
    expect(await lb.identityOwner(agentId)).toBe(stranger.address);

    await expect(checkLink(lb, { link, signature, expected })).resolves.toEqual({
      ok: false,
      code: "bad_signature",
      ...(await knownFacts(link, stranger.address)),
    });
  });
});

describe("faults, races and recovery of the create, on the same chain", () => {
  /** anvil's own controls: automine, mining a block, taking a transaction out of the pool. */
  let node: TestClient;

  beforeAll(() => {
    if (!anvil) throw new Error("anvil is not running");
    node = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(anvil.rpcUrl) });
  });

  /**
   * Run `fn` with automine off, so transactions wait in the pool until the case mines a block.
   * Automine is always switched back on, and a block is mined if anything is still pending, so a
   * case that failed half-way leaves nothing to the next one.
   */
  async function withAutomineOff<T>(fn: () => Promise<T>): Promise<T> {
    await node.setAutomine(false);
    try {
      return await fn();
    } finally {
      await node.setAutomine(true);
      if ((await node.getTxpoolStatus()).pending > 0) await node.mine({ blocks: 1 });
    }
  }

  /** The controller grant of `selector` to the executor, as the admin gives or withdraws it. */
  const executorGrant = (selector: Hex) => ({
    admin: walletOf(admin),
    pub,
    controller: stack.controller,
    selector,
    account: executor.address,
  });

  /** A fresh identity owned by `owner`, and its link, signed by `owner` and accepted. */
  async function acceptedKeyLink(): Promise<{ link: LegalBodyLink; check: Accepted }> {
    const link = await newLink(await registerByKey(owner));
    const check = accepted(
      await checkLink(lb, { link, signature: await signLink(owner, link), expected }),
    );
    return { link, check };
  }

  function sentOf(result: SubmitCreateResult): Extract<SubmitCreateResult, { status: "sent" }> {
    if (result.status !== "sent")
      throw new Error(`expected the create to be sent, got ${result.status}`);
    return result;
  }

  /** What a relay seam's revert names, after its "reverted in simulation: " prefix. */
  function revertDetail(e: unknown): string {
    if (!(e instanceof ContractRevertError)) throw new Error(`expected a revert, got ${String(e)}`);
    const marker = "reverted in simulation: ";
    const at = e.message.indexOf(marker);
    if (at < 0) throw new Error(`a revert without its detail: ${e.message}`);
    return e.message.slice(at + marker.length);
  }

  test("a missing grant is a fault of the platform, not a refusal of the link: with createLegalBody revoked from the executor, checkLink throws LegalBodyChainFaultError(NotAuthorized)", async () => {
    const link = await newLink(await registerByKey(owner));
    const signature = await signLink(owner, link);
    const grant = executorGrant(LEGAL_BODY_FACTORY_SELECTORS.createLegalBody);

    await revokeSelector(grant);
    let fault: unknown;
    try {
      fault = await checkLink(lb, { link, signature, expected }).catch((e: unknown) => e);
    } finally {
      await grantSelector(grant);
    }
    expect(fault).toBeInstanceOf(LegalBodyChainFaultError);
    expect((fault as LegalBodyChainFaultError).errorName).toBe("NotAuthorized");
    // The refusal is the controller's, naming the selector and the executor.
    expect(revertDetail((fault as LegalBodyChainFaultError).cause)).toBe(
      `NotAuthorized(${LEGAL_BODY_FACTORY_SELECTORS.createLegalBody}, ${executor.address})`,
    );

    // With the grant back, the same link is accepted.
    accepted(await checkLink(lb, { link, signature, expected }));
  });

  test("the executor cannot dissolve a body through the controller: without a grant the controller refuses, and with one the body refuses", async () => {
    const { link, check } = await acceptedKeyLink();
    const { created } = await createAccepted(link, check);
    const dissolve = {
      target: created.legalBody,
      abi: legalManagerAbi as Abi,
      functionName: "initiateDissolution",
      args: [],
    };
    const selector = toFunctionSelector("initiateDissolution()");

    // Both refusals are named NotAuthorized: the controller's carries the selector and the caller,
    // the body's carries nothing. The message tells them apart, the name cannot.
    const byController = await arc.estimateRelayedCall(dissolve).catch((e: unknown) => e);
    expect(byController).toBeInstanceOf(ContractRevertError);
    expect((byController as ContractRevertError).errorName).toBe("NotAuthorized");
    expect(revertDetail(byController)).toBe(`NotAuthorized(${selector}, ${executor.address})`);

    const grant = executorGrant(selector);
    await grantSelector(grant);
    let byBody: unknown;
    try {
      byBody = await arc.estimateRelayedCall(dissolve).catch((e: unknown) => e);
    } finally {
      await revokeSelector(grant);
    }
    expect(byBody).toBeInstanceOf(ContractRevertError);
    expect((byBody as ContractRevertError).errorName).toBe("NotAuthorized");
    expect(revertDetail(byBody)).toBe("NotAuthorized()");
  });

  test("an identity that changes hands after the check: submitCreate's own fresh simulation refuses the link, and nothing is recorded or sent", async () => {
    const { link, check } = await acceptedKeyLink();
    await mined(
      await walletOf(owner).writeContract({
        address: stack.registry,
        abi: iIdentityRegistryAbi,
        functionName: "transferFrom",
        args: [owner.address, stranger.address, link.agentId],
        account: owner,
        chain: anvilChain,
      }),
    );
    expect(await lb.identityOwner(link.agentId)).toBe(stranger.address);
    const before = await executorCounts();

    const recorded: unknown[] = [];
    const refusal = await lb
      .submitCreate({
        link,
        signature: check.signature,
        record: (signed) => {
          recorded.push(signed);
          return true;
        },
      })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContractRevertError);
    expect((refusal as ContractRevertError).errorName).toBe("BadSignature");
    expect(recorded).toEqual([]);
    expect(await executorCounts()).toEqual(before);
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("absent");
  });

  test("a create that reverts when it is mined costs a bounded amount and leaves no body", async () => {
    const wallet = await deployContract(walletOf(deployer), pub, "MockERC1271Wallet", [
      owner.address,
    ]);
    const agentId = await registerByWallet(wallet);
    const link = await newLink(agentId);
    const check = accepted(
      await checkLink(lb, { link, signature: await signLink(owner, link), expected }),
    );
    const before = await executorCounts();

    // Automine off: the create is sent, then dropped from the pool; a state change is mined in a
    // block of its own; the same signed bytes are sent again and mined in the next block.
    const sent = await withAutomineOff(async () => {
      const result = sentOf(
        await lb.submitCreate({ link, signature: check.signature, record: () => true }),
      );
      await node.dropTransaction({ hash: result.txHash });
      const change = await walletOf(owner).writeContract({
        address: wallet,
        abi: refusingWalletAbi,
        functionName: "setRefuseAll",
        args: [true],
        account: owner,
        chain: anvilChain,
      });
      await node.mine({ blocks: 1 });
      expect((await pub.getTransactionReceipt({ hash: change })).status).toBe("success");
      await lb.rebroadcastCreate(result.rawTx);
      await node.mine({ blocks: 1 });
      return result;
    });

    await expect(
      lb.createOutcome(sent.txHash, { bodyAddress: check.bodyAddress }),
    ).resolves.toEqual({ status: "reverted" });
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: wallet }),
    ).resolves.toBe("absent");

    // One transaction, bounded by its gas limit and its fee cap.
    const receipt = await pub.getTransactionReceipt({ hash: sent.txHash });
    const tx = await pub.getTransaction({ hash: sent.txHash });
    expect(tx.gas).toBeLessThanOrEqual(CREATE_GAS_CEILING);
    expect(receipt.gasUsed).toBeLessThan(tx.gas);
    expect(receipt.gasUsed * receipt.effectiveGasPrice).toBeLessThanOrEqual(CREATE_MAX_FEE_WEI);
    expect(await lb.executorNonce()).toBe(before.mined + 1);
  });

  test("two creates for one link, one after the other: one body, and the second is refused by its own simulation with LegalBodyExists", async () => {
    const { link, check } = await acceptedKeyLink();
    await createAccepted(link, check);
    const before = await executorCounts();

    const recorded: unknown[] = [];
    const second = await lb
      .submitCreate({
        link,
        signature: check.signature,
        record: (signed) => {
          recorded.push(signed);
          return true;
        },
      })
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ContractRevertError);
    expect((second as ContractRevertError).errorName).toBe("LegalBodyExists");
    expect(recorded).toEqual([]);
    expect(await executorCounts()).toEqual(before);
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("created");
  });

  test("two creates for one link at the same time: both pass their simulation and are sent with consecutive nonces, and once mined one created the body and the other reverted", async () => {
    const { link, check } = await acceptedKeyLink();
    const before = await executorCounts();
    const recorded: { txHash: Hex; rawTx: Hex; nonce: number }[] = [];
    const create = () =>
      lb.submitCreate({
        link,
        signature: check.signature,
        record: (signed) => {
          recorded.push(signed);
          return true;
        },
      });

    const sent = await withAutomineOff(async () => {
      // Both simulations pass because the simulation runs outside the sender lock, and the lock
      // then gives the two creates consecutive nonces. Whichever takes it first gets the lower one.
      const both = (await Promise.all([create(), create()]))
        .map(sentOf)
        .sort((a, b) => a.nonce - b.nonce);
      expect(both.map((s) => s.nonce)).toEqual([before.pending, before.pending + 1]);
      expect([...recorded].sort((a, b) => a.nonce - b.nonce)).toEqual(
        both.map(({ txHash, rawTx, nonce }) => ({ txHash, rawTx, nonce })),
      );
      await node.mine({ blocks: 1 });
      return both;
    });

    const outcomes = await Promise.all(
      sent.map((s) => lb.createOutcome(s.txHash, { bodyAddress: check.bodyAddress })),
    );
    expect(outcomes.map((o) => o.status).sort()).toEqual(["created", "reverted"]);
    const winner = outcomes.find((o) => o.status === "created");
    expect(winner).toMatchObject({
      created: { legalBody: check.bodyAddress, agentId: link.agentId },
    });
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("created");
    expect(await lb.executorNonce()).toBe(before.mined + 2);
  });

  test("a lost response: the same bytes sent again while pending are the same transaction, so there is one receipt and the executor's nonce moves by one", async () => {
    const { link, check } = await acceptedKeyLink();
    const before = await executorCounts();

    const sent = await withAutomineOff(async () => {
      const result = sentOf(
        await lb.submitCreate({ link, signature: check.signature, record: () => true }),
      );
      await expect(
        lb.createOutcome(result.txHash, { bodyAddress: check.bodyAddress }),
      ).resolves.toEqual({ status: "absent" });
      await expect(lb.rebroadcastCreate(result.rawTx)).resolves.toBeUndefined();
      await node.mine({ blocks: 1 });
      return result;
    });

    const receipt = await pub.getTransactionReceipt({ hash: sent.txHash });
    expect(receipt.status).toBe("success");
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    expect(block.transactions).toEqual([sent.txHash]);
    expect(await lb.executorNonce()).toBe(before.mined + 1);
    await expect(
      lb.createOutcome(sent.txHash, { bodyAddress: check.bodyAddress }),
    ).resolves.toMatchObject({ status: "created", created: { legalBody: check.bodyAddress } });
  });

  test("a record that answers false: nothing is sent, and the executor's pending nonce is unchanged", async () => {
    const { link, check } = await acceptedKeyLink();
    const before = await executorCounts();

    const handed: { txHash: Hex; rawTx: Hex; nonce: number }[] = [];
    const result = await lb.submitCreate({
      link,
      signature: check.signature,
      record: (signed) => {
        handed.push(signed);
        return false;
      },
    });
    expect(result).toEqual({ status: "not_recorded" });
    expect(handed).toHaveLength(1);
    expect(handed[0]?.nonce).toBe(before.pending);
    expect(await executorCounts()).toEqual(before);
    await expect(
      lb.createdState({ bodyAddress: check.bodyAddress, identityOwner: owner.address }),
    ).resolves.toBe("absent");

    // The nonce was not skipped: the next create from the executor takes it.
    const next = sentOf(
      await lb.submitCreate({ link, signature: check.signature, record: () => true }),
    );
    expect(next.nonce).toBe(before.pending);
    await lb.confirmCreate(next.txHash, { bodyAddress: check.bodyAddress });
  });

  test("findCreation finds the creating transaction from the block the link was checked at, and returns undefined for a range before it", async () => {
    const { link, check } = await acceptedKeyLink();
    const { txHash, created } = await createAccepted(link, check);
    expect(created.blockNumber).toBeGreaterThan(check.observedAtBlock);

    const found = await lb.findCreation({
      bodyAddress: check.bodyAddress,
      fromBlock: BigInt(check.observedAtBlock),
    });
    expect(found).toEqual(created);
    expect(found?.txHash).toBe(txHash);

    await expect(
      lb.findCreation({
        bodyAddress: check.bodyAddress,
        fromBlock: 0n,
        toBlock: BigInt(created.blockNumber - 1),
      }),
    ).resolves.toBeUndefined();
  });
});
