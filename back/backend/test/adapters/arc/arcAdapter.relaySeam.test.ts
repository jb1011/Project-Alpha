/**
 * THE RELAY SEAM: a call relayed through the controller, prepared OUTSIDE the sender lock, then
 * signed, recorded and sent INSIDE it — the sequence the treasury top-up already uses.
 *
 * Every case runs against two fake nodes behind viem's real `http` transport (`helpers/
 * nodeTransport`): one without `eth_fillTransaction`, where viem asks the single calls, and one
 * that fills a transaction the way Arc testnet does, nonce included. The node answers on the wire
 * and viem builds every error itself; nothing here is hand-built.
 */
import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Hex,
  RpcRequestError,
  type TransactionSerialized,
  type WalletClient,
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, test } from "vitest";
import { legalBodyFactoryAbi } from "../../../src/abis/generated";
import {
  ArcAdapter,
  type PreparedFundTransfer,
  type PreparedPlatformTx,
  type PreparedRelayedCall,
  type RelayedCall,
} from "../../../src/adapters/arc/arcAdapter";
import { ContractRevertError, decodedRevertName } from "../../../src/adapters/arc/relay";
import {
  nextSenderNonce,
  resetSenderNonces,
  withSenderLock,
} from "../../../src/adapters/arc/senderLock";
import {
  FAKE_NODE_CHAIN,
  type FakeRpcNode,
  LOCAL_TEST_ACCOUNT,
  causeChain,
  failureOf,
  nodeRevert,
} from "../../helpers/fakeRpcNode";
import {
  ARC_FILLED_NONCE,
  NODE_GAS_ESTIMATE,
  type NodeTransportOptions,
  type PresetNode,
  fillLikeArc,
  fillUnavailable,
} from "../../helpers/nodeTransport";

// The nonce floors are process-wide, so each test starts from a fresh ledger (see senderLock.ts).
beforeEach(() => resetSenderNonces());

/** Checksummed with capitals, so a lower-case spelling of it is a different string. */
const CONTROLLER = "0x000000000000000000000000000000000000c0DE" as Address;
/** The relayed call's target: a placeholder legal-body factory. */
const FACTORY = "0x00000000000000000000000000000000000000fb" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
/** Somewhere that is not the controller. */
const ELSEWHERE = "0x00000000000000000000000000000000000000dd" as Address;
const GUARDIAN = "0x000000000000000000000000000000000000BbBB" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;

/** The platform key: anvil's account #1, a local account, as production signs. */
const PLATFORM = LOCAL_TEST_ACCOUNT;
/** anvil's account #2, a published test key: a signer that is NOT the platform. */
const STRANGER = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);

/** What the node reports as the platform's pending count. It does not move on its own. */
const PENDING = 7;
/** The gas limit the caller decided on, from an estimate plus whatever headroom it applies. */
const GAS = 300_000n;

const CREATE_ARGS = [
  42n,
  GUARDIAN,
  172_800n,
  `0x${"ab".repeat(32)}` as Hex,
  1_900_000_000n,
  `0x${"cd".repeat(65)}` as Hex,
] as const;

const CALL: RelayedCall = {
  target: FACTORY,
  abi: legalBodyFactoryAbi as Abi,
  functionName: "createLegalBody",
  args: CREATE_ARGS,
};

/** The relay encoding, built by hand: the target's calldata, then the target's 20 bytes. */
const relayBytes = (target: Address): Hex =>
  concatHex([
    encodeFunctionData({
      abi: legalBodyFactoryAbi,
      functionName: "createLegalBody",
      args: CREATE_ARGS,
    }),
    target.toLowerCase() as Hex,
  ]);
const RELAY_DATA = relayBytes(FACTORY);

/**
 * The real `ArcAdapter` over `node`, sending as `account` (the platform key unless told).
 *
 * `preparedGas` puts a gas of its own into every prepared request, after viem's preparation: the
 * shape of any preparation step (a chain hook, a library change) that decides the gas itself.
 */
function adapterOver(
  node: FakeRpcNode,
  opts: { controller?: Address; account?: Account | null; preparedGas?: bigint } = {},
): ArcAdapter {
  const account = opts.account === null ? undefined : (opts.account ?? PLATFORM);
  const wallet = createWalletClient({ account, chain: FAKE_NODE_CHAIN, transport: node.transport });
  const preparedGas = opts.preparedGas;
  const managerWallet: WalletClient =
    preparedGas === undefined
      ? wallet
      : ({
          ...wallet,
          prepareTransactionRequest: async (args: never) => ({
            ...(await wallet.prepareTransactionRequest(args)),
            gas: preparedGas,
          }),
        } as unknown as WalletClient);
  return new ArcAdapter({
    publicClient: createPublicClient({ chain: FAKE_NODE_CHAIN, transport: node.transport }),
    managerWallet,
    chainId: FAKE_NODE_CHAIN.id,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller: opts.controller,
  });
}

interface Mode {
  name: string;
  make: (opts?: NodeTransportOptions) => PresetNode;
  /** The request whose answer is the gas estimate. */
  estimatedBy: string;
  /** The nonce a prepared request carries in this mode: an Arc-like node fills one. */
  preparedNonce: number | undefined;
}

const MODES: Mode[] = [
  {
    name: "a node without eth_fillTransaction",
    make: fillUnavailable,
    estimatedBy: "eth_estimateGas",
    preparedNonce: undefined,
  },
  {
    name: "a node that fills like Arc",
    make: fillLikeArc,
    estimatedBy: "eth_fillTransaction",
    preparedNonce: ARC_FILLED_NONCE,
  },
];

/** The transaction a request asks the node about, as viem put it on the wire. */
const askedTx = (params: unknown[]) =>
  params[0] as { from?: Address; to?: Address; data?: Hex; gas?: Hex };

describe.each(MODES)("relay seam, $name", (mode) => {
  const node = () => mode.make({ lockKey: PLATFORM.address, pendingNonce: PENDING });

  /** Prepare outside the lock, then sign and send inside it: the whole seam, once. */
  async function signAndSend(adapter: ArcAdapter) {
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    return withSenderLock(PLATFORM.address, async () => {
      const signed = await adapter.signRelayedCall(prepared);
      return { signed, hash: await adapter.sendRawRelayedCall(signed.rawTx) };
    });
  }

  test("estimateRelayedCall asks about the exact relay bytes, from the executor, at the controller", async () => {
    const n = node();
    const gas = await adapterOver(n, { controller: CONTROLLER }).estimateRelayedCall(CALL);
    expect(gas).toBe(NODE_GAS_ESTIMATE);

    const asked = n.requests.filter(
      (r) => r.method === "eth_fillTransaction" || r.method === "eth_estimateGas",
    );
    // The answer came from the request this mode estimates with...
    expect(asked.at(-1)?.method).toBe(mode.estimatedBy);
    // ...and every question viem asked was about the same transaction.
    for (const r of asked) {
      const tx = askedTx(r.params);
      expect(isAddressEqual(tx.from!, PLATFORM.address)).toBe(true);
      expect(isAddressEqual(tx.to!, CONTROLLER)).toBe(true);
      expect(tx.data?.toLowerCase()).toBe(RELAY_DATA);
    }
    expect(n.calls).not.toContain("eth_sendRawTransaction");
  });

  test("the seam requires controller mode, and an account to send as", async () => {
    const n = node();
    const noController = adapterOver(n);
    await expect(noController.estimateRelayedCall(CALL)).rejects.toThrow(
      /no controller is configured/,
    );
    await expect(noController.prepareRelayedCall(CALL, GAS)).rejects.toThrow(
      /no controller is configured/,
    );
    const noAccount = adapterOver(n, { controller: CONTROLLER, account: null });
    await expect(noAccount.estimateRelayedCall(CALL)).rejects.toThrow(
      /manager wallet has no account/,
    );
    await expect(noAccount.prepareRelayedCall(CALL, GAS)).rejects.toThrow(
      /manager wallet has no account/,
    );
    // Refused before anything was asked of the node.
    expect(n.requests).toEqual([]);
  });

  test("a node revert carrying BadSignature() becomes a ContractRevertError named BadSignature", async () => {
    const data = encodeErrorResult({ abi: legalBodyFactoryAbi, errorName: "BadSignature" });
    const n = mode.make({ preflight: nodeRevert(data) });
    const err = await failureOf(
      adapterOver(n, { controller: CONTROLLER }).estimateRelayedCall(CALL),
    );

    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("BadSignature");
    expect(decodedRevertName(err)).toBe("BadSignature");
    expect((err as Error).message).toBe(
      `relay createLegalBody -> ${FACTORY} via controller ${CONTROLLER} reverted in simulation: BadSignature()`,
    );
    // The bytes came from the node's own JSON-RPC error, as viem received it.
    const rpc = (err as { cause: BaseError }).cause.walk((e) => e instanceof RpcRequestError);
    expect(rpc).toMatchObject({ code: 3, data });
    expect(n.calls).not.toContain("eth_sendRawTransaction");
  });

  test("a timeout is rethrown untouched", async () => {
    const n = mode.make({ preflight: { hang: true }, timeoutMs: 50 });
    const err = await failureOf(
      adapterOver(n, { controller: CONTROLLER }).estimateRelayedCall(CALL),
    );
    expect(err).not.toBeInstanceOf(ContractRevertError);
    expect(decodedRevertName(err)).toBeUndefined();
    // viem's own error, as viem threw it: nothing wrapped it.
    expect(err).toBeInstanceOf(BaseError);
    expect(causeChain(err)[0]).toBe("EstimateGasExecutionError");
    expect(causeChain(err)).toContain("TimeoutError");
    expect(n.calls).not.toContain("eth_sendRawTransaction");
  });

  test("prepareRelayedCall keeps the given gas, and every call it makes is outside the lock", async () => {
    const n = node();
    const prepared = await adapterOver(n, { controller: CONTROLLER }).prepareRelayedCall(CALL, GAS);

    expect(prepared.call).toBe(CALL);
    expect(prepared.gas).toBe(GAS);
    expect(prepared.request.gas).toBe(GAS);
    expect(isAddressEqual(prepared.request.to!, CONTROLLER)).toBe(true);
    expect(prepared.request.data?.toLowerCase()).toBe(RELAY_DATA);
    expect(prepared.request.chainId).toBe(FAKE_NODE_CHAIN.id);
    expect(typeof prepared.request.maxFeePerGas).toBe("bigint");

    expect(n.requests.length).toBeGreaterThan(0);
    expect(n.requests.filter((r) => r.locked)).toEqual([]);
    // The gas the node was told is the caller's, so the node estimates nothing...
    for (const r of n.requests.filter((r) => r.method === "eth_fillTransaction"))
      expect(askedTx(r.params).gas).toBe(toHex(GAS));
    expect(n.calls).not.toContain("eth_estimateGas");
    // ...and no nonce is picked here: that is the locked step.
    expect(n.calls).not.toContain("eth_getTransactionCount");
  });

  test("signRelayedCall outside the lock is refused", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER });
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    await expect(adapter.signRelayedCall(prepared)).rejects.toThrow(/sender lock is not held/);
    expect(n.calls).not.toContain("eth_getTransactionCount");
    expect(n.raw).toEqual([]);
  });

  test("signRelayedCall refuses a request that is not addressed to the controller, or whose data was altered", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER });
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    const misaddressed: PreparedRelayedCall = {
      ...prepared,
      request: { ...prepared.request, to: ELSEWHERE },
    };
    // The same call, relayed to another target.
    const altered: PreparedRelayedCall = {
      ...prepared,
      request: { ...prepared.request, data: relayBytes(ELSEWHERE) },
    };
    const asked = n.requests.length;

    await withSenderLock(PLATFORM.address, async () => {
      await expect(adapter.signRelayedCall(misaddressed)).rejects.toThrow(
        /not addressed to the configured controller/,
      );
      await expect(adapter.signRelayedCall(altered)).rejects.toThrow(
        /not the relay encoding of createLegalBody/,
      );
      // Refused before signing: not even the nonce was read.
      expect(n.requests.length).toBe(asked);

      // The comparison is about the address and the bytes, not how they are spelled.
      const respelled: PreparedRelayedCall = {
        ...prepared,
        request: {
          ...prepared.request,
          to: CONTROLLER.toLowerCase() as Address,
          data: `0x${prepared.request.data!.slice(2).toUpperCase()}` as Hex,
        },
      };
      await expect(adapter.signRelayedCall(respelled)).resolves.toMatchObject({ nonce: PENDING });
    });
    expect(n.raw).toEqual([]);
  });

  test("signRelayedCall refuses a request whose gas, value or chain id was altered", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER });
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    const withRequest = (change: Record<string, unknown>): PreparedRelayedCall => ({
      ...prepared,
      request: { ...prepared.request, ...change } as PreparedPlatformTx,
    });
    const asked = n.requests.length;

    await withSenderLock(PLATFORM.address, async () => {
      await expect(adapter.signRelayedCall(withRequest({ gas: GAS + 1n }))).rejects.toThrow(
        /gas \(300001\) is not the gas limit it was prepared with \(300000\)/,
      );
      await expect(adapter.signRelayedCall(withRequest({ value: 1n }))).rejects.toThrow(
        /carries a value \(1\)/,
      );
      await expect(
        adapter.signRelayedCall(withRequest({ chainId: FAKE_NODE_CHAIN.id + 1 })),
      ).rejects.toThrow(/is for chain 5042003, not this adapter's chain 5042002/);
      // Refused before signing: not even the nonce was read.
      expect(n.requests.length).toBe(asked);

      // A value of zero is no value.
      await expect(adapter.signRelayedCall(withRequest({ value: 0n }))).resolves.toMatchObject({
        nonce: PENDING,
      });
    });
    expect(n.raw).toEqual([]);
  });

  test("the gas prepared and signed is the caller's, whatever the preparation filled in", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER, preparedGas: NODE_GAS_ESTIMATE });
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    expect(prepared.gas).toBe(GAS);
    expect(prepared.request.gas).toBe(GAS);

    const signed = await withSenderLock(PLATFORM.address, () => adapter.signRelayedCall(prepared));
    expect(parseTransaction(signed.rawTx).gas).toBe(GAS);
  });

  test("inside the lock: sign, then send; the hash is known before anything is sent", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER });
    const prepared = await adapter.prepareRelayedCall(CALL, GAS);
    // An Arc-like node fills a nonce of its own into the prepared request.
    expect((prepared.request as { nonce?: number }).nonce).toBe(mode.preparedNonce);

    const recorded: Hex[] = [];
    const { signed, hash } = await withSenderLock(PLATFORM.address, async () => {
      const signed = await adapter.signRelayedCall(prepared);
      // Signed, hashed and recordable, and nothing is on the wire yet.
      expect(n.raw).toEqual([]);
      expect(signed.txHash).toBe(keccak256(signed.rawTx));
      recorded.push(signed.txHash);
      return { signed, hash: await adapter.sendRawRelayedCall(signed.rawTx) };
    });

    expect(hash).toBe(recorded[0]);
    expect(n.raw).toEqual([signed.rawTx]);
    // The nonce is the one picked inside the lock, whatever the prepared request carried.
    const tx = parseTransaction(signed.rawTx);
    expect(signed.nonce).toBe(PENDING);
    expect(tx.nonce).toBe(PENDING);
    // The relayed call itself, as prepared.
    expect(isAddressEqual(tx.to!, CONTROLLER)).toBe(true);
    expect(tx.data).toBe(RELAY_DATA);
    expect(tx.gas).toBe(GAS);
    expect(tx.chainId).toBe(FAKE_NODE_CHAIN.id);
    // Signed by the platform key, the executor.
    const signer = await recoverTransactionAddress({
      serializedTransaction: signed.rawTx as TransactionSerialized,
    });
    expect(signer).toBe(PLATFORM.address);
    // Inside the lock: the nonce read and the raw send, and nothing else.
    expect(n.requests.filter((r) => r.locked).map((r) => r.method)).toEqual([
      "eth_getTransactionCount",
      "eth_sendRawTransaction",
    ]);
  });

  test("a re-send of the same bytes creates no second transaction", async () => {
    const n = node();
    const adapter = adapterOver(n, { controller: CONTROLLER });
    const { signed, hash } = await signAndSend(adapter);
    expect(hash).toBe(signed.txHash);

    // The node already has these bytes. The call may throw for that; either outcome is fine.
    const again = await adapter.sendRawRelayedCall(signed.rawTx).then(
      (hash) => ({ hash }),
      (error: unknown) => ({ error }),
    );
    if ("hash" in again) expect(again.hash).toBe(signed.txHash);

    // The transport saw the same bytes twice: one transaction, under one hash.
    expect(n.raw).toEqual([signed.rawTx, signed.rawTx]);
    expect(new Set(n.raw.map((r) => keccak256(r)))).toEqual(new Set([signed.txHash]));
  });

  test.each(["sendRawRelayedCall", "sendRawFundTreasury"] as const)(
    "%s of bytes signed by ANOTHER key does not raise the platform's nonce floor",
    async (door) => {
      const n = node();
      const adapter = adapterOver(n, { controller: CONTROLLER });
      /** The platform's next nonce when the node still says PENDING: the floor, if one is set. */
      const nextNonce = () =>
        withSenderLock(PLATFORM.address, () =>
          nextSenderNonce(PLATFORM.address, async () => PENDING),
        );
      const bytesFrom = (account: Account) =>
        account.signTransaction!({
          type: "eip1559",
          chainId: FAKE_NODE_CHAIN.id,
          nonce: 50,
          to: CONTROLLER,
          gas: GAS,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          data: RELAY_DATA,
        });

      // A stranger's transaction at nonce 50: the node takes it, and the platform's next nonce is
      // still the node's count.
      const foreign = await bytesFrom(STRANGER);
      await expect(adapter[door](foreign)).resolves.toBe(keccak256(foreign));
      expect(await nextNonce()).toBe(PENDING);

      // The platform's own transaction at nonce 50 does raise it, past the node's stale count.
      const own = await bytesFrom(PLATFORM);
      await expect(adapter[door](own)).resolves.toBe(keccak256(own));
      expect(await nextNonce()).toBe(51);
    },
  );

  test.each(["sendRawRelayedCall", "sendRawFundTreasury"] as const)(
    "%s of bytes the node accepts but that do not parse as a transaction resolves with the node's hash, and leaves the nonce floor where it was",
    async (door) => {
      const n = node();
      const adapter = adapterOver(n, { controller: CONTROLLER });
      /** The platform's next nonce when the node still says PENDING: the floor, if one is set. */
      const nextNonce = () =>
        withSenderLock(PLATFORM.address, () =>
          nextSenderNonce(PLATFORM.address, async () => PENDING),
        );
      expect(await nextNonce()).toBe(PENDING);

      // Once the node has taken the bytes, nothing may turn that send into an error.
      const unparseable = "0x1234" as Hex;
      await expect(adapter[door](unparseable)).resolves.toBe(keccak256(unparseable));
      expect(n.raw).toEqual([unparseable]);
      expect(await nextNonce()).toBe(PENDING);
    },
  );
});

test("a node that fills its own gas: the prepared and the signed gas are still the caller's", async () => {
  const n = fillLikeArc({
    lockKey: PLATFORM.address,
    pendingNonce: PENDING,
    fillGas: NODE_GAS_ESTIMATE,
  });
  const adapter = adapterOver(n, { controller: CONTROLLER });
  const prepared = await adapter.prepareRelayedCall(CALL, GAS);
  // The node was told the caller's gas, and answers its own.
  const fills = n.requests.filter((r) => r.method === "eth_fillTransaction");
  expect(fills.map((r) => askedTx(r.params).gas)).toEqual([toHex(GAS)]);

  expect(prepared.gas).toBe(GAS);
  expect(prepared.request.gas).toBe(GAS);
  const signed = await withSenderLock(PLATFORM.address, () => adapter.signRelayedCall(prepared));
  expect(parseTransaction(signed.rawTx).gas).toBe(GAS);
});

test("the fund signer still refuses a nonce that is not a number, in the same words", async () => {
  // `sendClient` is a structural interface: these two methods are the whole contract, so the odd
  // answer comes from here and no node is asked anything.
  const n = fillLikeArc();
  const adapter = new ArcAdapter({
    publicClient: createPublicClient({ chain: FAKE_NODE_CHAIN, transport: n.transport }),
    managerWallet: createWalletClient({
      account: PLATFORM,
      chain: FAKE_NODE_CHAIN,
      transport: n.transport,
    }),
    sendClient: {
      getTransactionCount: async () => Number.NaN,
      sendRawTransaction: async () => {
        throw new Error("nothing may be sent");
      },
    },
    chainId: FAKE_NODE_CHAIN.id,
    factory: FACTORY,
    identityRegistry: REGISTRY,
  });
  const prepared: PreparedFundTransfer = {
    usdc: USDC,
    treasury: TREASURY,
    amount: 5n,
    request: {
      to: USDC,
      data: "0x",
      gas: 100_000n,
      chainId: FAKE_NODE_CHAIN.id,
      type: "eip1559",
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    } as unknown as PreparedPlatformTx,
  };
  await expect(
    withSenderLock(PLATFORM.address, () => adapter.signFundTreasury(prepared)),
  ).rejects.toThrow(/^signFundTreasury: no usable nonce for this transfer \(got NaN\)$/);
  expect(n.requests).toEqual([]);
});
