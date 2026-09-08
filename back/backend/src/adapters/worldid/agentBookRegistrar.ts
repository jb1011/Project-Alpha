import {
  http,
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getTransactionCount } from "viem/actions";
import { worldchain } from "viem/chains";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../payments/agentBookReader";
import { withKeyedLock } from "../../payments/keyedMutex";
import { ContractRevertError } from "../arc/relay";

/** World's registration app and action (design v3 §1.3). The contract bakes the resulting
 *  external nullifier in with no getter, so the only validation is one live registration. */
export const AGENTBOOK_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
export const AGENTBOOK_ACTION = "agentbook-registration";

/** The registrar's lock key: one submitter EOA, one EVM nonce sequence, one writer at a time. */
export const SUBMITTER_LOCK = "worldchain-submitter";

/** `abi.encodePacked(address, uint256)`: 52 bytes. The padded 64-byte form type-checks, encodes,
 *  and reverts on-chain AFTER the guardian has done the work (design v3 §4.1). */
export function buildSignal(agent: Address, nonce: bigint): Hex {
  return encodePacked(["address", "uint256"], [agent, nonce]);
}

/** World's `hashToField`: keccak256 of the packed bytes, shifted right by 8 bits. */
export function hashSignal(signal: Hex): bigint {
  return BigInt(keccak256(signal)) >> 8n;
}

export interface RegisterArgs {
  agent: Address;
  root: bigint;
  nonce: bigint;
  nullifierHash: bigint;
  proof: bigint[]; // exactly 8; validated by the route's zod schema
}

/** The Groth16 proof as the ABI's fixed-size tuple. A wrong length is caught HERE rather than
 *  encoded into a call that would revert on-chain after the guardian has already proved. */
type Proof8 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
function proof8(proof: bigint[]): Proof8 {
  if (proof.length !== 8) throw new Error("register: proof must have exactly 8 elements");
  return proof as unknown as Proof8;
}

export function encodeRegister(a: RegisterArgs): Hex {
  return encodeFunctionData({
    abi: AGENT_BOOK_ABI,
    functionName: "register",
    args: [a.agent, a.root, a.nonce, a.nullifierHash, proof8(a.proof)],
  });
}

export interface AgentBookRegistrar {
  address: Address;
  getNextNonce(agent: Address, blockTag?: "latest" | "safe"): Promise<bigint>;
  /** `null` = definitively unregistered; throws on transport (same discipline as the reader). */
  lookupHuman(agent: Address, blockTag?: "latest" | "safe"): Promise<string | null>;
  /** Throws `ContractRevertError` for a deterministic revert, anything else for transport. */
  simulateRegister(args: RegisterArgs): Promise<void>;
  /** Signs under the submitter lock and returns the raw transaction plus the EVM nonce it used.
   *  Nothing is broadcast here: the caller persists first (bridge-legs rule), then broadcasts. */
  signRegister(args: RegisterArgs): Promise<{ rawTx: Hex; submitterNonce: number }>;
  broadcast(rawTx: Hex): Promise<Hex>;
  receiptStatus(txHash: Hex): Promise<"success" | "reverted" | null>;
  /** The submitter's MINED transaction count on the write provider — the count that tells a
   *  registration we were REPLACED (the chain moved past the nonce we signed) from one that is
   *  still pending. Never the pending count: that one includes our own unmined transaction. */
  submitterNonce(): Promise<number>;
  submitterBalance(): Promise<bigint>;
}

/** The submitter's wallet client: World Chain, account known up front. */
type SubmitterWalletClient = WalletClient<Transport, Chain, Account>;

export interface RegistrarOptions {
  submitterPrivateKey: Hex;
  readRpcUrl: string;
  writeRpcUrl: string;
  contractAddress?: Address;
  /** Test seam. */
  clients?: { publicClient: PublicClient; walletClient: SubmitterWalletClient };
}

export function createAgentBookRegistrar(opts: RegistrarOptions): AgentBookRegistrar {
  const account = privateKeyToAccount(opts.submitterPrivateKey);
  const contract: Address = opts.contractAddress ?? AGENT_BOOK_ADDRESS;
  const publicClient =
    opts.clients?.publicClient ??
    createPublicClient({ chain: worldchain, transport: http(opts.readRpcUrl) });
  // Annotated, not inferred: viem's bare `WalletClient` is a union over "account known" and
  // "account supplied per call", and neither `prepareTransactionRequest` nor `signTransaction` is
  // callable on that union. Ours always carries the submitter account and World Chain.
  const walletClient: SubmitterWalletClient =
    opts.clients?.walletClient ??
    createWalletClient({ chain: worldchain, transport: http(opts.writeRpcUrl), account });

  /**
   * A deterministic revert, or nothing.
   *
   * `simulateContract` decodes the revert bytes against the ABI we hand it, so viem hands us a
   * typed `ContractFunctionRevertedError` inside the thrown error's cause chain — relay.ts's
   * `relayRevertError` cannot be reused for it: that one needs the relay's target/controller pair
   * and folds `shortMessage` into the message, and NOTHING but the error NAME may leave this
   * adapter (an RPC's prose can carry the calldata, and the calldata carries the proof).
   * Used by BOTH write paths — `simulateContract` and the gas estimate inside `signRegister` —
   * because the second is where a state change since simulation shows up. Anything that is neither
   * a revert nor an estimate revert is transport, and transport says nothing about the contract.
   */
  const revertOf = (e: unknown): ContractRevertError | undefined => {
    if (!(e instanceof BaseError)) return undefined;
    const named = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (named instanceof ContractFunctionRevertedError)
      return new ContractRevertError(
        `AgentBook.register reverted: ${named.data?.errorName ?? "unknown"}`,
        named.data?.errorName,
        { cause: e },
      );
    // Gas estimation reverts too, and it does so with no ABI in hand: the node just says
    // "execution reverted". No name is recoverable, but the failure is every bit as deterministic
    // as a decoded one — the class, not the name, is what the caller acts on.
    const bare = e.walk(
      (x) => x instanceof ExecutionRevertedError || x instanceof EstimateGasExecutionError,
    );
    if (bare)
      return new ContractRevertError("AgentBook.register reverted: unknown", undefined, {
        cause: e,
      });
    return undefined;
  };

  return {
    address: account.address,
    async getNextNonce(agent, blockTag = "latest") {
      return (await publicClient.readContract({
        address: contract,
        abi: AGENT_BOOK_ABI,
        functionName: "getNextNonce",
        args: [agent],
        blockTag,
      })) as bigint;
    },
    async lookupHuman(agent, blockTag = "latest") {
      const id = (await publicClient.readContract({
        address: contract,
        abi: AGENT_BOOK_ABI,
        functionName: "lookupHuman",
        args: [agent],
        blockTag,
      })) as bigint;
      return id === 0n ? null : toHex(id);
    },
    async simulateRegister(args) {
      const proof = proof8(args.proof);
      try {
        await publicClient.simulateContract({
          account,
          address: contract,
          abi: AGENT_BOOK_ABI,
          functionName: "register",
          args: [args.agent, args.root, args.nonce, args.nullifierHash, proof],
        });
      } catch (e) {
        const revert = revertOf(e);
        if (revert) throw revert;
        throw e;
      }
    },
    async signRegister(args) {
      return withKeyedLock(SUBMITTER_LOCK, async () => {
        try {
          const request = await walletClient.prepareTransactionRequest({
            account,
            chain: worldchain,
            to: contract,
            data: encodeRegister(args),
          });
          // The nonce is the whole reason this returns before broadcasting: the caller records it,
          // so a replacement can be built later. An unrecorded `NaN` would make that impossible,
          // and quietly — better to fail here than to persist a hole.
          if (request.nonce === undefined)
            throw new Error("signRegister: prepared request has no nonce");
          const rawTx = await walletClient.signTransaction(request);
          return { rawTx, submitterNonce: Number(request.nonce) };
        } catch (e) {
          // Simulation happened earlier and against a different block: by now someone else may
          // have registered this agent, and the estimate inside `prepareTransactionRequest` is
          // where we find out. Classify it exactly like a simulate revert.
          const revert = revertOf(e);
          if (revert) throw revert;
          throw e;
        }
      });
    },
    async broadcast(rawTx) {
      return walletClient.sendRawTransaction({ serializedTransaction: rawTx });
    },
    async receiptStatus(txHash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: txHash });
        return r.status === "success" ? "success" : "reverted";
      } catch (e) {
        // `null` means ONE thing: the chain has no receipt for this hash yet, so the reconciler
        // should keep waiting. viem says exactly that with `TransactionReceiptNotFoundError` —
        // matched by type, not by its prose, because several other viem errors ("Block at number
        // ... could not be found", any wrapper carrying that text) also read as "not found" and
        // mean the read BROKE. Parking those in the pending branch would wait forever on a receipt
        // nobody is fetching. `walk` (which tests the error itself first) because a transport or a
        // caller's client may have wrapped it.
        if (e instanceof BaseError && e.walk((x) => x instanceof TransactionReceiptNotFoundError))
          return null;
        throw e;
      }
    },
    async submitterNonce() {
      // "latest", NOT "pending": the caller compares this with the nonce it signed, and a pending
      // count includes OUR OWN transaction still sitting in the mempool — which would read as
      // "the chain has moved past us, we were replaced" for a registration that is merely slow.
      // Deliberately the WRITE provider too: the number is only meaningful next to the nonce the
      // signer took, and two RPCs can disagree by a transaction. `getTransactionCount` is a public
      // action, so it is called on the wallet client rather than decorating a second client onto
      // the same URL.
      return getTransactionCount(walletClient, { address: account.address, blockTag: "latest" });
    },
    async submitterBalance() {
      return publicClient.getBalance({ address: account.address });
    },
  };
}
