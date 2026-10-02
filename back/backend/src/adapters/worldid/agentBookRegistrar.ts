import {
  http,
  type Account,
  type Address,
  BaseError,
  type Chain,
  ContractFunctionRevertedError,
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

/** A node's answer to a gas estimate the sender cannot fund, "gas required exceeds allowance (N)"
 *  in geth's words, which viem raises as `ExecutionRevertedError` all the same (see `revertOf`). */
const SENDER_CANNOT_PAY_FOR_GAS = /gas required exceeds allowance/i;

/** A node's own words for a call the contract refused. */
const EXECUTION_REVERTED = /execution reverted/i;

/** `abi.encodePacked(address, uint256)`: 52 bytes. The padded 64-byte form type-checks, encodes,
 *  and reverts on-chain AFTER the guardian has done the work (design v3 §4.1). */
export function buildSignal(agent: Address, nonce: bigint): Hex {
  return encodePacked(["address", "uint256"], [agent, nonce]);
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

/** The signed transaction and the EVM nonce it was signed under, handed to the caller's persist
 *  step BEFORE anything reaches the wire (the bridge-legs rule). */
export interface SignedRegistration {
  rawTx: Hex;
  submitterNonce: number;
}

/**
 * What the caller's persist step reports back. Only `"won"` — the row this submission now owns —
 * earns a broadcast; `"lost"` and `"inflight"` mean another submission holds the row and ours must
 * never reach the chain unrecorded.
 *
 * Spelled the same as `AgentBookRepository.claimSubmit`'s result, which is what the route hands in,
 * and declared here rather than imported so an adapter does not depend on persistence.
 */
export type SubmitClaim = "won" | "lost" | "inflight";

export interface SubmitResult {
  signed: SignedRegistration;
  claim: SubmitClaim;
  /** `null` when the claim was not won (nothing was sent) or the broadcast itself failed. */
  txHash: Hex | null;
  /** Set only when the broadcast failed: the error NAME, never its prose — viem prints the call
   *  arguments and the call arguments are the proof. The caller logs it; the reconciler owns the
   *  re-broadcast from the stored raw transaction. */
  broadcastErrorName?: string;
}

export interface AgentBookRegistrar {
  address: Address;
  getNextNonce(agent: Address, blockTag?: "latest" | "safe"): Promise<bigint>;
  /** `null` = definitively unregistered; throws on transport (same discipline as the reader). */
  lookupHuman(agent: Address, blockTag?: "latest" | "safe"): Promise<string | null>;
  /** Throws `ContractRevertError` for a deterministic revert, anything else for transport. */
  simulateRegister(args: RegisterArgs): Promise<void>;
  /**
   * Sign → persist → broadcast, the WHOLE sequence under the submitter lock (design v3 §4.1).
   *
   * The EVM nonce is taken inside `prepareTransactionRequest` and is only unique while nothing
   * else signs or sends on this account, so the persist step has to happen inside the same lock:
   * with it outside, two guardians vouching at once prepare on the same nonce and one proof is
   * thrown away. Throws `ContractRevertError` only when the fee-less simulation (the one
   * `simulateRegister` runs) says the call reverts: an estimate that fails as a revert is asked
   * again through that simulation and never judges the proof itself, because the submitter's
   * balance shapes its answer. Anything else is transport; a failed BROADCAST is not a failure at
   * all (the raw tx is recorded) and comes back as `txHash: null`.
   */
  submitRegister(
    args: RegisterArgs,
    persist: (signed: SignedRegistration) => SubmitClaim | Promise<SubmitClaim>,
  ): Promise<SubmitResult>;
  broadcast(rawTx: Hex): Promise<Hex>;
  receiptStatus(txHash: Hex): Promise<"success" | "reverted" | null>;
  /** The submitter's MINED transaction count on the READ provider — the count that tells a
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
   * Does this error say the call REVERTED? A `ContractRevertError` if so, nothing otherwise.
   *
   * `simulateContract` decodes the revert bytes against the ABI we hand it, so viem hands us a
   * typed `ContractFunctionRevertedError` inside the thrown error's cause chain — relay.ts's
   * `relayRevertError` cannot be reused for it: that one needs the relay's target/controller pair
   * and folds `shortMessage` into the message, and NOTHING but the error NAME may leave this
   * adapter (an RPC's prose can carry the calldata, and the calldata carries the proof).
   *
   * Asked of both write paths, with different weight. A revert found by `simulate` (the fee-less
   * simulation) is the verdict on the proof. A revert found by the gas estimate inside
   * `submitRegister` is not: `prepareAndSign` only takes it as the reason to ask `simulate` again.
   * Anything that is not a revert is transport, and transport says nothing about the contract.
   */
  const revertOf = (e: unknown): ContractRevertError | undefined => {
    if (!(e instanceof BaseError)) return undefined;
    const named = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (named instanceof ContractFunctionRevertedError) {
      // The decoded class is not evidence on its own: viem builds it for JSON-RPC code 3 AND for
      // -32603, a node's internal error, whatever its message. So it counts as a revert only when
      // something says the contract refused: revert bytes, or the node's own words "execution
      // reverted" (left by viem in `details`, READ here and never copied). Without either, a node
      // that could not serve the call has judged nothing: transport.
      const bytes = named.raw !== undefined && named.raw !== "0x";
      if (!bytes && !EXECUTION_REVERTED.test(named.details ?? "")) return undefined;
      return new ContractRevertError(
        `AgentBook.register reverted: ${named.data?.errorName ?? "unknown"}`,
        named.data?.errorName,
        { cause: e },
      );
    }
    // The gas estimate has no ABI in hand, so a node's refusal there carries no name: viem raises
    // its "execution reverted" (JSON-RPC code 3, with or without revert data) as
    // `ExecutionRevertedError`, and this branch counts that class as a revert, nameless. Found by
    // the estimate, that is NOT a verdict on the proof. The estimate runs with fee fields, so the
    // sender's balance shapes its answer, and some nodes answer a sender that can pay for most,
    // not all, of the gas with this same plain code 3. An estimate's revert is only a reason to
    // ask the fee-less simulation, which is the judge (`prepareAndSign`). A refusal of the
    // simulation itself that viem did not decode lands here too, and there it is the verdict.
    //
    // viem gives the class to a second node answer too, "gas required exceeds allowance (N)",
    // sometimes under code 3: the reply when the call runs out of gas at the most the estimate may
    // use, a limit the node caps at what the SENDER's balance buys at the gas price it applies.
    // That text already says the failure is about the sender, not the proof, so it is not a
    // revert here and needs no simulation: it stays transport-shaped and travels on unchanged,
    // whichever wrapper viem put round it (`EstimateGasExecutionError`, or
    // `TransactionExecutionError` when it asked `eth_fillTransaction` first), like the estimates
    // that fail for want of gas money (`InsufficientFundsError`) or of intrinsic gas, which viem
    // raises as other classes. A revert verdict would end the guardian's session `failed` at the
    // route, and a World proof cannot be replayed, for a registration that only needs the wallet
    // topped up.
    //
    // The node's text is where viem leaves it, in the class's `details`. It is READ here, never
    // copied: nothing but the error NAME leaves this adapter.
    const bare = e.walk((x) => x instanceof ExecutionRevertedError);
    if (
      bare instanceof ExecutionRevertedError &&
      !SENDER_CANNOT_PAY_FOR_GAS.test(bare.details ?? "")
    )
      return new ContractRevertError("AgentBook.register reverted: unknown", undefined, {
        cause: e,
      });
    return undefined;
  };

  /**
   * The fee-less simulation of `register`: the ONE judge of a proof.
   *
   * An `eth_call` with no gas price or fee fields, so the node charges the sender nothing for gas
   * and the submitter's balance plays no part in the answer. Resolves when the call passes; throws
   * a `ContractRevertError` when it reverts, and anything else exactly as viem threw it.
   * `simulateRegister` is this, and `prepareAndSign` asks it again when its estimate fails as a
   * revert.
   */
  const simulate = async (args: RegisterArgs): Promise<void> => {
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
  };

  /**
   * Prepare and sign. NOT locked itself: its only caller already holds `SUBMITTER_LOCK`, and
   * `withKeyedLock` is a promise chain, not a re-entrant mutex — taking it twice on one path
   * would wait forever on the entry that is still running.
   */
  const prepareAndSign = async (args: RegisterArgs): Promise<SignedRegistration> => {
    try {
      const request = await walletClient.prepareTransactionRequest({
        account,
        chain: worldchain,
        to: contract,
        data: encodeRegister(args),
      });
      // The nonce is the whole reason the caller sees this before anything is broadcast: it
      // records it, so a replacement can be built later. An unrecorded `NaN` would make that
      // impossible, and quietly — better to fail here than to persist a hole.
      if (request.nonce === undefined)
        throw new Error("submitRegister: prepared request has no nonce");
      const rawTx = await walletClient.signTransaction(request);
      return { rawTx, submitterNonce: Number(request.nonce) };
    } catch (e) {
      // The estimate inside `prepareTransactionRequest` runs with fee fields, so the submitter's
      // balance shapes its answer. A revert found there may be the contract (someone registered
      // this agent since `simulateRegister`), or a sender that can pay for most, not all, of the
      // gas, which some nodes answer with the same plain "execution reverted". Nothing in the
      // answer tells the two apart, so the estimate never judges the proof: its revert is only the
      // reason to ask the judge, the fee-less simulation of the same call, now, on the latest
      // block. That costs one extra read, inside the submitter lock and on this failure path only.
      if (!revertOf(e)) throw e;
      let verdict: ContractRevertError | undefined;
      try {
        await simulate(args);
      } catch (s) {
        if (s instanceof ContractRevertError) verdict = s;
      }
      // A simulation that reverts is the verdict, carrying any name it could decode. One that
      // passes, or that could not be run, leaves the estimate's failure saying nothing about the
      // contract: that is transport, and it goes on as the ORIGINAL error, untouched.
      throw verdict ?? e;
    }
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
    simulateRegister: simulate,
    async submitRegister(args, persist) {
      return withKeyedLock(SUBMITTER_LOCK, async () => {
        const signed = await prepareAndSign(args);
        const claim = await persist(signed);
        // Not ours to send. The signature is spent, but a transaction nobody recorded is worse:
        // it would consume the submitter's nonce and land a registration no row points at.
        if (claim !== "won") return { signed, claim, txHash: null };
        try {
          const txHash = await walletClient.sendRawTransaction({
            serializedTransaction: signed.rawTx,
          });
          return { signed, claim, txHash };
        } catch (e) {
          // Persisted before broadcast: the reconciler re-broadcasts the same raw tx (§6 rule 4),
          // so "submitted with no hash yet" is the honest answer and not a failure.
          return {
            signed,
            claim,
            txHash: null,
            broadcastErrorName: e instanceof Error ? e.name : "unknown",
          };
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
      // "latest", NOT "pending": the only caller (the reconciler) compares this with the nonce it
      // signed, and a pending count includes OUR OWN transaction still sitting in the mempool —
      // which would read as "the chain has moved past us, we were replaced" for a registration
      // that is merely slow.
      //
      // Deliberately the READ provider (FR-E): the verdict this feeds is "our nonce was used by
      // something else AND `receiptStatus` still cannot find our transaction", and `receiptStatus`
      // reads through `publicClient`. Two providers a transaction apart would let those two facts
      // contradict each other and mark a successful vouch `failed`. Signing keeps its own pending
      // nonce on the wallet client, where the broadcast goes.
      return getTransactionCount(publicClient, { address: account.address, blockTag: "latest" });
    },
    async submitterBalance() {
      return publicClient.getBalance({ address: account.address });
    },
  };
}
