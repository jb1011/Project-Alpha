import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  getAbiItem,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { iIdentityRegistryAbi, legalBodyFactoryAbi, noviControllerAbi } from "../../abis/generated";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../../errors";
import type { LegalBodyLink } from "../../legalBody/link";
import { isRangeTooLargeError } from "../../monitor/scan";
import type { ArcAdapter, PreparedRelayedCall, RelayedCall } from "./arcAdapter";
import { RECEIPT_TIMEOUT_MS } from "./receipts";
import { ContractRevertError } from "./relay";
import { withSenderLock } from "./senderLock";

/**
 * The part of the ArcAdapter a LegalBodyChain uses: the relay seam a create goes through, the
 * executor that signs it and its mined nonce, and the chain it signs for.
 */
export type RelaySeam = Pick<
  ArcAdapter,
  | "estimateRelayedCall"
  | "prepareRelayedCall"
  | "signRelayedCall"
  | "sendRawRelayedCall"
  | "platformAddress"
  | "platformNonce"
  | "chainId"
>;

export interface LegalBodyChainDeps {
  publicClient: PublicClient;
  arc: RelaySeam;
  /** The chain the factory is on. It must be the chain the relay seam signs for. */
  chainId: number;
  factory: Address;
  identityRegistry: Address;
  /** Wall clock in milliseconds, for the head-age check. Defaults to `Date.now`. */
  now?: () => number;
  /** The oldest head, in seconds against `now()`, that {LegalBodyChain.head} believes. Unset: no
   *  check. */
  maxHeadAgeSeconds?: number;
}

/** Headroom added to the node's estimate to get the gas limit a create is sent with. */
export const CREATE_GAS_HEADROOM_PERCENT = 25n;
/**
 * The highest gas LIMIT a create may be sent with. The factory checks a contract owner's signature
 * by calling the owner, so part of a create's gas is spent in code the platform does not control;
 * this ceiling and {CREATE_MAX_FEE_WEI} bound what one create can cost. It bounds the limit, not
 * the estimate: the limit is what the transaction may spend.
 */
export const CREATE_GAS_CEILING = 600_000n;
/** The most a create's fee may reach, `gas × fee per gas`, in wei of the gas token: 0.25 USDC. */
export const CREATE_MAX_FEE_WEI = 250_000_000_000_000_000n;
/** How many blocks one search for a creation's log asks the node about. */
export const CREATION_LOG_WINDOW_BLOCKS = 5_000n;
/** The narrowest window a node's "range too large" answer halves {CREATION_LOG_WINDOW_BLOCKS} to.
 *  A node that refuses this many blocks is not refusing the width. */
const CREATION_LOG_WINDOW_FLOOR = 500n;

/** The factory's event for a body it created. */
const LEGAL_BODY_CREATED = getAbiItem({ abi: legalBodyFactoryAbi, name: "LegalBodyCreated" });

/** The gas limit a create is sent with: the estimate plus {CREATE_GAS_HEADROOM_PERCENT}. */
function createGasLimit(estimate: bigint): bigint {
  return estimate + (estimate * CREATE_GAS_HEADROOM_PERCENT) / 100n;
}

/** The create's gas limit would be above {CREATE_GAS_CEILING}. Nothing was signed. */
export class LegalBodyGasTooHighError extends Error {
  constructor(readonly estimate: bigint) {
    super(
      `createLegalBody: the node estimates ${estimate} gas, a limit of ${createGasLimit(estimate)} with ${CREATE_GAS_HEADROOM_PERCENT} % headroom, above the ${CREATE_GAS_CEILING} ceiling: refusing to send it`,
    );
    this.name = "LegalBodyGasTooHighError";
  }
}

/** The create's fee could be above {CREATE_MAX_FEE_WEI}. Nothing was signed. */
export class LegalBodyFeeTooHighError extends Error {
  constructor(
    readonly fee: bigint,
    priced: { gas: bigint; feePerGas: bigint },
  ) {
    super(
      `createLegalBody: the fee could reach ${fee} wei (${priced.gas} gas at ${priced.feePerGas} wei), above the ${CREATE_MAX_FEE_WEI} wei cap: refusing to sign it`,
    );
    this.name = "LegalBodyFeeTooHighError";
  }
}

/**
 * The create's simulation was refused by the platform's own setup, not by anything in the
 * customer's link: the controller's grant to the executor, the factory's owner, or the factory's
 * deployment of the body. Ours to fix, and never a refusal of the link. `errorName` is the contract
 * error's name; the ContractRevertError it came from is the cause.
 */
export class LegalBodyChainFaultError extends Error {
  constructor(
    readonly errorName: string,
    options?: { cause?: unknown },
  ) {
    super(
      `createLegalBody reverted with ${errorName}: a fault in the platform's setup, not a refusal of the link`,
      options,
    );
    this.name = "LegalBodyChainFaultError";
  }
}

/**
 * The revert names that make a create's simulation a platform FAULT: every error the controller
 * declares (its grants, its target bindings, its checks of the relay bytes), the factory's
 * ownership errors (the controller must own it), and the errors of the factory's deployment of a
 * body.
 *
 * Any other revert stays the ContractRevertError the relay seam built: the factory's refusals of
 * the link (`BadSignature`, `BadDeadline`, `LegalBodyExists`, `BadGuardian`, `BadDelay`), and a
 * revert with any other name or none.
 *
 * BY NAME, and valid only with the FACTORY as the relay's target: a legal body declares a
 * `NotAuthorized()` of its own, so a call relayed to a body needs its own list.
 */
const CREATE_FAULT_NAMES: ReadonlySet<string> = new Set([
  ...noviControllerAbi.flatMap((item) => (item.type === "error" ? [item.name] : [])),
  "OwnableUnauthorizedAccount",
  "OwnableInvalidOwner",
  "FailedDeployment",
  "InsufficientBalance",
  "NotContract",
  "NotImplementation",
]);

/** A body the factory created, as its `LegalBodyCreated` log and that log's block tell it. */
export interface LegalBodyCreated {
  legalBody: Address;
  agentId: bigint;
  identityOwner: Address;
  guardian: Address;
  linkDigest: Hex;
  /** The transaction that created it. */
  txHash: Hex;
  blockNumber: number;
  /** The creating block's timestamp, in seconds. */
  deployedAt: number;
}

/** What {LegalBodyChain.submitCreate} did with the create it signed. */
export type SubmitCreateResult =
  | { status: "sent"; txHash: Hex; rawTx: Hex; nonce: number }
  | { status: "unconfirmed"; txHash: Hex; rawTx: Hex; nonce: number; cause: unknown }
  | { status: "not_recorded" };

/** What the chain says, at the moment it is asked, about one create transaction
 *  ({LegalBodyChain.createOutcome}). */
export type CreateOutcome =
  | { status: "created"; created: LegalBodyCreated }
  | { status: "reverted" }
  | { status: "absent" };

/**
 * Refuse a prepared create whose fee could be above {CREATE_MAX_FEE_WEI}. The most the transaction
 * can cost is `gas × (maxFeePerGas ?? gasPrice)` of the request that will be signed. A request
 * without both numbers is not signed either: its cost would not be bounded at all.
 */
function checkCreateFee(prepared: PreparedRelayedCall): void {
  const { gas, maxFeePerGas, gasPrice } = prepared.request as {
    gas?: unknown;
    maxFeePerGas?: unknown;
    gasPrice?: unknown;
  };
  const feePerGas = maxFeePerGas ?? gasPrice;
  if (typeof gas !== "bigint" || typeof feePerGas !== "bigint")
    throw new Error(
      `createLegalBody: the prepared transaction has no fee or no gas limit to bound its cost (gas ${String(gas)}, maxFeePerGas ${String(maxFeePerGas)}, gasPrice ${String(gasPrice)}): refusing to sign it`,
    );
  const fee = gas * feePerGas;
  if (fee > CREATE_MAX_FEE_WEI) throw new LegalBodyFeeTooHighError(fee, { gas, feePerGas });
}

function isThenable(x: unknown): boolean {
  return (
    (typeof x === "object" || typeof x === "function") &&
    x !== null &&
    typeof (x as { then?: unknown }).then === "function"
  );
}

/**
 * A node's answer to a re-send that means it already has these bytes, or that their nonce is spent.
 * Arc and geth say `already known`; anvil says `transaction already imported` while the transaction
 * is pending; after it is mined, `nonce too low`.
 */
const ALREADY_HAS_BYTES = /already known|already imported|nonce too low/i;

/** How far down a cause chain to look for the node's words. Cause chains can be cyclic. */
const MAX_CAUSE_HOPS = 8;

/**
 * Did the node refuse a re-send because it already has these bytes, or because their nonce is
 * spent? Read from the node's WORDS: viem raises that answer in the same class as a real refusal,
 * with the words in `details`. So each error's `details`, `shortMessage` and `message` are read,
 * down the cause chain.
 */
function nodeAlreadyHasBytes(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e instanceof Error && hops < MAX_CAUSE_HOPS; hops++) {
    const { details, shortMessage } = e as { details?: unknown; shortMessage?: unknown };
    for (const text of [details, shortMessage, e.message])
      if (typeof text === "string" && ALREADY_HAS_BYTES.test(text)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** `ERC721NonexistentToken(uint256)`: the registry's `ownerOf` revert for an identity that does
 *  not exist. */
const NONEXISTENT_TOKEN_SELECTOR = "0x7e273289";

/**
 * True ONLY when the node answered with a revert whose bytes start with `ERC721NonexistentToken`.
 *
 * The error class is not evidence. viem raises a node's JSON-RPC `-32603` (an internal error, not
 * an answer) as a `ContractFunctionRevertedError` too, and a code-3 revert may carry no bytes at
 * all. So the revert bytes decide: `raw` holds them whether or not the ABI declares the error
 * (`signature` is set only when it does not, so it cannot be relied on).
 */
function isNonexistentToken(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return false;
  return reverted.raw?.toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR) === true;
}

/**
 * The backend's reads of the LegalBodyFactory and of the ERC-8004 identity registry it reads
 * owners from.
 *
 * Every read that takes a `blockNumber` sends it to the node. A caller that checks several facts
 * about one link pins them all to one block, so they describe one state of the chain and cannot
 * disagree with each other. Without a block number, a read is at the latest block.
 *
 * A read that could not be made throws. It is never turned into an answer such as "no owner" or
 * "no body".
 *
 * The create is a call relayed through the controller and sent by the executor. It is simulated
 * and bounded before it is signed, and its signed bytes are recorded before they are sent
 * ({submitCreate}). Whether it created the body is the chain's to say, from its receipt
 * ({createOutcome}, {confirmCreate}) or, with no transaction to ask about, from the factory's
 * logs ({findCreation}).
 */
export class LegalBodyChain {
  constructor(private readonly d: LegalBodyChainDeps) {
    if (d.chainId !== d.arc.chainId)
      throw new Error(
        `LegalBodyChain: chain id ${d.chainId} differs from the relay seam's ${d.arc.chainId}: refusing to read one chain and sign for another`,
      );
  }

  get chainId(): number {
    return this.d.chainId;
  }
  get factory(): Address {
    return this.d.factory;
  }
  /** The address that signs and pays for a create: the relay seam's platform account. */
  get executor(): Address | undefined {
    return this.d.arc.platformAddress;
  }

  /**
   * The latest block's number and timestamp. With `maxHeadAgeSeconds` set, a head older than that
   * against `now()` throws: a node that has stopped following the chain must not be believed.
   */
  async head(): Promise<{ number: bigint; timestamp: bigint }> {
    const block = await this.d.publicClient.getBlock({ blockTag: "latest" });
    const maxAge = this.d.maxHeadAgeSeconds;
    if (maxAge !== undefined) {
      const ageSeconds = (this.d.now ?? Date.now)() / 1000 - Number(block.timestamp);
      if (ageSeconds > maxAge)
        throw new Error(
          `LegalBodyChain: the node's head (block ${block.number}) is ${ageSeconds} s old, above the ${maxAge} s limit: a stale node is not believed`,
        );
    }
    return { number: block.number, timestamp: block.timestamp };
  }

  async hasCode(address: Address, blockNumber?: bigint): Promise<boolean> {
    const code = await this.d.publicClient.getCode({ address, blockNumber });
    return code !== undefined && code !== "0x";
  }

  /** The identity's owner, or `undefined` when the registry says the identity does not exist.
   *  Every other failure throws (see {isNonexistentToken}). */
  async identityOwner(agentId: bigint, blockNumber?: bigint): Promise<Address | undefined> {
    try {
      return await this.d.publicClient.readContract({
        address: this.d.identityRegistry,
        abi: iIdentityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber,
      });
    } catch (e) {
      if (isNonexistentToken(e)) return undefined;
      throw e;
    }
  }

  /** The digest the identity owner signs for `link`, as the factory computes it. */
  linkDigest(link: LegalBodyLink, blockNumber?: bigint): Promise<Hex> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkDigest",
      args: [
        link.agentId,
        link.guardian,
        link.amendmentDelay,
        link.operatingAgreementHash,
        link.deadline,
      ],
      blockNumber,
    });
  }

  /** The address the body for this link digest has, or will have. */
  predictLegalBody(linkDigest: Hex, blockNumber?: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "predictLegalBody",
      args: [linkDigest],
      blockNumber,
    });
  }

  /** The identity owner whose signature created this body, or `undefined` when the factory did not
   *  create it (its `identityOwnerAtCreation` is the zero address). */
  async bodyCreator(legalBody: Address, blockNumber?: bigint): Promise<Address | undefined> {
    const creator = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "identityOwnerAtCreation",
      args: [legalBody],
      blockNumber,
    });
    return isAddressEqual(creator, zeroAddress) ? undefined : creator;
  }

  /**
   * What the chain says about a body meant to be created at `bodyAddress` for `identityOwner`,
   * whatever became of the transaction: `absent` when the factory recorded no creator, `created`
   * when the creator is `identityOwner`, `foreign` when it is someone else.
   *
   * One read is the whole fact. Only the factory can put code at a predicted address, and it
   * records the creator in the same transaction.
   */
  async createdState(p: {
    bodyAddress: Address;
    identityOwner: Address;
    blockNumber?: bigint;
  }): Promise<"created" | "absent" | "foreign"> {
    const creator = await this.bodyCreator(p.bodyAddress, p.blockNumber);
    if (creator === undefined) return "absent";
    return isAddressEqual(creator, p.identityOwner) ? "created" : "foreign";
  }

  /** The body this agent is linked to right now, by the factory's own predicate, or `undefined`. */
  async linkedLegalBody(agentId: bigint): Promise<Address | undefined> {
    const body = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "linkedLegalBody",
      args: [agentId],
    });
    return isAddressEqual(body, zeroAddress) ? undefined : body;
  }

  /** The exact pointer bytes the identity owner writes to link the agent to `legalBody`. */
  encodePointer(legalBody: Address): Promise<Hex> {
    return this.d.publicClient.readContract({
      address: this.d.factory,
      abi: legalBodyFactoryAbi,
      functionName: "encodePointer",
      args: [legalBody],
    });
  }

  /** The executor's MINED transaction count, never the pending one. */
  executorNonce(): Promise<number> {
    return this.d.arc.platformNonce();
  }

  /** The executor, or a throw: a create is signed and paid for by it, under its sender lock. */
  private requireExecutor(): Address {
    const executor = this.executor;
    if (!executor)
      throw new Error(
        "LegalBodyChain: no executor (the relay seam has no platform account): refusing to create a legal body",
      );
    return executor;
  }

  /** The factory's `createLegalBody` for `link`: its five fields in the contract's order, then the
   *  identity owner's signature. */
  private createCall(link: LegalBodyLink, signature: Hex): RelayedCall {
    return {
      target: this.d.factory,
      abi: legalBodyFactoryAbi as Abi,
      functionName: "createLegalBody",
      args: [
        link.agentId,
        link.guardian,
        link.amendmentDelay,
        link.operatingAgreementHash,
        link.deadline,
        signature,
      ],
    };
  }

  /**
   * Simulate the relayed create of the body for `link` and return the gas LIMIT to send it with:
   * the estimate plus {CREATE_GAS_HEADROOM_PERCENT}. A limit above {CREATE_GAS_CEILING} throws
   * {LegalBodyGasTooHighError}.
   *
   * The simulation is the contract's verdict on the link. A revert that names a platform fault
   * (see {CREATE_FAULT_NAMES}) becomes {LegalBodyChainFaultError}; any other revert, the
   * factory's refusals of the link included, is rethrown as the relay seam's ContractRevertError.
   * A failure that is not a revert, such as an RPC outage, is rethrown untouched.
   */
  async estimateCreate(link: LegalBodyLink, signature: Hex): Promise<bigint> {
    this.requireExecutor();
    let estimate: bigint;
    try {
      estimate = await this.d.arc.estimateRelayedCall(this.createCall(link, signature));
    } catch (e) {
      if (e instanceof ContractRevertError && e.errorName && CREATE_FAULT_NAMES.has(e.errorName))
        throw new LegalBodyChainFaultError(e.errorName, { cause: e });
      throw e;
    }
    const limit = createGasLimit(estimate);
    if (limit > CREATE_GAS_CEILING) throw new LegalBodyGasTooHighError(estimate);
    return limit;
  }

  /**
   * Create the body for `link`: simulate, bound, sign, record, send.
   *
   * Outside the executor's sender lock: a fresh simulation ({estimateCreate}; no gas figure can be
   * passed in, so it cannot be skipped), the preparation at that limit, then the fee cap
   * ({CREATE_MAX_FEE_WEI}, {LegalBodyFeeTooHighError}).
   *
   * Inside the lock, and nothing else: sign, hand the signed transaction to `record`, send. Nothing
   * goes on the wire that was not recorded first. `record` answers synchronously: `true` sends;
   * `false` sends nothing and the result is `not_recorded`; anything else, a promise included,
   * throws with nothing sent. A failed send does not throw, because the node may have the bytes:
   * the result is `unconfirmed`, with the hash, the bytes and the cause, and the chain settles it.
   *
   * So every throw from this call means nothing was sent.
   */
  async submitCreate(p: {
    link: LegalBodyLink;
    signature: Hex;
    record: (signed: { txHash: Hex; rawTx: Hex; nonce: number }) => boolean;
  }): Promise<SubmitCreateResult> {
    const executor = this.requireExecutor();
    const gas = await this.estimateCreate(p.link, p.signature);
    const prepared = await this.d.arc.prepareRelayedCall(this.createCall(p.link, p.signature), gas);
    checkCreateFee(prepared);
    return withSenderLock(executor, async (): Promise<SubmitCreateResult> => {
      const { txHash, rawTx, nonce } = await this.d.arc.signRelayedCall(prepared);
      // `record` gets a copy: what is sent is what was signed, whatever it does with its argument.
      const recorded: unknown = p.record({ txHash, rawTx, nonce });
      if (recorded === false) return { status: "not_recorded" };
      if (recorded !== true)
        throw new Error(
          isThenable(recorded)
            ? "createLegalBody: record returned a promise; it must record synchronously and return true or false. Nothing was sent"
            : `createLegalBody: record returned ${String(recorded)}, not true or false. Nothing was sent`,
        );
      try {
        await this.d.arc.sendRawRelayedCall(rawTx);
      } catch (cause) {
        return { status: "unconfirmed", txHash, rawTx, nonce, cause };
      }
      return { status: "sent", txHash, rawTx, nonce };
    });
  }

  /**
   * Send signed create bytes again, with the executor's sender lock held for the send. A re-send
   * is the same transaction, never a second one.
   *
   * A refusal that means the node already has these bytes, or that their nonce is spent, is
   * swallowed (see {nodeAlreadyHasBytes}): there is nothing more to send, and whether the body
   * exists is the chain's to say. Any other failure throws. With no executor, it throws before
   * taking any lock or sending.
   */
  async rebroadcastCreate(rawTx: Hex): Promise<void> {
    const executor = this.requireExecutor();
    await withSenderLock(executor, async () => {
      try {
        await this.d.arc.sendRawRelayedCall(rawTx);
      } catch (e) {
        if (!nodeAlreadyHasBytes(e)) throw e;
      }
    });
  }

  /**
   * What the chain says about the create `txHash`, asked once, without waiting:
   * - `absent`: the node has no receipt for it (viem's TransactionReceiptNotFoundError, and only
   *   that): not mined yet, or never;
   * - `reverted`: mined, and reverted;
   * - `created`: mined, with the factory's `LegalBodyCreated` for `expected.bodyAddress`.
   *
   * A successful receipt without that event throws, and so does any failure to read the receipt (a
   * rate limit, a timeout): neither is an answer about the transaction.
   */
  async createOutcome(txHash: Hex, expected: { bodyAddress: Address }): Promise<CreateOutcome> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.d.publicClient.getTransactionReceipt({ hash: txHash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return { status: "absent" };
      throw e;
    }
    if (receipt.status !== "success") return { status: "reverted" };
    return {
      status: "created",
      created: await this.creationIn(txHash, receipt, expected.bodyAddress),
    };
  }

  /**
   * Wait for the create `txHash`, for at most {RECEIPT_TIMEOUT_MS}, and read from that one receipt
   * the body it created at `expected.bodyAddress`.
   *
   * Running out of time throws ChainTxUnconfirmedError: the create may still be mined. A reverted
   * receipt throws ChainTxRevertedError. A successful receipt without the factory's
   * `LegalBodyCreated` for the body throws. Any other failure is rethrown untouched.
   */
  async confirmCreate(txHash: Hex, expected: { bodyAddress: Address }): Promise<LegalBodyCreated> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.d.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof WaitForTransactionReceiptTimeoutError)
        throw new ChainTxUnconfirmedError("createLegalBody", txHash);
      throw e;
    }
    if (receipt.status !== "success") throw new ChainTxRevertedError("createLegalBody", txHash);
    return this.creationIn(txHash, receipt, expected.bodyAddress);
  }

  /**
   * The factory's creation of `bodyAddress`, searched for in its `LegalBodyCreated` logs by the
   * body's indexed topic, from `fromBlock` to `toBlock` (default: the head when called), forward,
   * one window of blocks at a time.
   *
   * A window is {CREATION_LOG_WINDOW_BLOCKS} wide, inclusive at both ends. A node's "range too
   * large" answer halves it for the rest of the search, down to {CREATION_LOG_WINDOW_FLOOR}; a
   * refusal at the floor throws. Any other failure to read throws. `undefined` means the whole range
   * was searched and the factory did not create the body in it. A log a reorg removed is ignored.
   */
  async findCreation(p: {
    bodyAddress: Address;
    fromBlock: bigint;
    toBlock?: bigint;
  }): Promise<LegalBodyCreated | undefined> {
    const toBlock = p.toBlock ?? (await this.head()).number;
    let window = CREATION_LOG_WINDOW_BLOCKS;
    let cursor = p.fromBlock;
    while (cursor <= toBlock) {
      const windowEnd = cursor + window - 1n;
      const end = windowEnd < toBlock ? windowEnd : toBlock;
      let logs: Awaited<ReturnType<LegalBodyChain["creationLogs"]>>;
      try {
        logs = await this.creationLogs(p.bodyAddress, cursor, end);
      } catch (e) {
        if (!isRangeTooLargeError(e)) throw e;
        if (window <= CREATION_LOG_WINDOW_FLOOR)
          throw new Error(
            `findCreation: the node refuses the factory's logs for blocks ${cursor} to ${end} as too wide a range, at the ${CREATION_LOG_WINDOW_FLOOR}-block floor: the search cannot go on`,
            { cause: e },
          );
        const halved = window / 2n;
        window = halved < CREATION_LOG_WINDOW_FLOOR ? CREATION_LOG_WINDOW_FLOOR : halved;
        continue;
      }
      const log = this.factoryCreation(logs, p.bodyAddress);
      if (log)
        return this.creationRecord(log.args, {
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });
      cursor = end + 1n;
    }
    return undefined;
  }

  /** The factory's `LegalBodyCreated` logs for `bodyAddress` in blocks `fromBlock` to `toBlock`,
   *  inclusive, by the body's indexed topic. */
  private creationLogs(bodyAddress: Address, fromBlock: bigint, toBlock: bigint) {
    return this.d.publicClient.getLogs({
      address: this.d.factory,
      event: LEGAL_BODY_CREATED,
      args: { legalBody: bodyAddress },
      fromBlock,
      toBlock,
    });
  }

  /**
   * The factory's `LegalBodyCreated` for `bodyAddress` among `logs`, or `undefined`. Only a log
   * the FACTORY emitted counts: any contract can emit an event with the same signature, and a
   * relayed call's receipt holds other contracts' logs too. A log a reorg removed does not count.
   */
  private factoryCreation(logs: readonly Log<bigint, number, false>[], bodyAddress: Address) {
    const fromFactory = logs.filter((l) => !l.removed && isAddressEqual(l.address, this.d.factory));
    return parseEventLogs({
      abi: legalBodyFactoryAbi,
      eventName: "LegalBodyCreated",
      logs: fromFactory,
    }).find((l) => isAddressEqual(l.args.legalBody, bodyAddress));
  }

  /** The creation in a SUCCESSFUL receipt of the create `txHash`. Without the factory's event for
   *  `bodyAddress`, it throws: the transaction succeeded and the chain does not say it created
   *  that body. */
  private async creationIn(
    txHash: Hex,
    receipt: TransactionReceipt,
    bodyAddress: Address,
  ): Promise<LegalBodyCreated> {
    const log = this.factoryCreation(receipt.logs, bodyAddress);
    if (!log)
      throw new Error(
        `createLegalBody ${txHash} succeeded, but the factory emitted no LegalBodyCreated for ${bodyAddress} in it`,
      );
    return this.creationRecord(log.args, { txHash, blockNumber: receipt.blockNumber });
  }

  /** A creation's record. `deployedAt` is the timestamp of the block it was mined in, read from
   *  the node by number; a failed read throws. */
  private async creationRecord(
    event: Pick<
      LegalBodyCreated,
      "legalBody" | "agentId" | "identityOwner" | "guardian" | "linkDigest"
    >,
    at: { txHash: Hex; blockNumber: bigint },
  ): Promise<LegalBodyCreated> {
    const block = await this.d.publicClient.getBlock({ blockNumber: at.blockNumber });
    return {
      legalBody: event.legalBody,
      agentId: event.agentId,
      identityOwner: event.identityOwner,
      guardian: event.guardian,
      linkDigest: event.linkDigest,
      txHash: at.txHash,
      blockNumber: Number(at.blockNumber),
      deployedAt: Number(block.timestamp),
    };
  }
}

/** What the create's caller needs of a LegalBodyChain. */
export type CreateChainPort = Pick<
  LegalBodyChain,
  | "chainId"
  | "factory"
  | "executor"
  | "head"
  | "createdState"
  | "executorNonce"
  | "submitCreate"
  | "rebroadcastCreate"
  | "createOutcome"
  | "confirmCreate"
  | "findCreation"
>;
