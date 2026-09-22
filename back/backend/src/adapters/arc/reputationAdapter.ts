import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
} from "viem";
import { reputationRegistryAbi } from "../../abis/generated";
import { ChainTxRevertedError } from "../../errors";
import { type LocalSendClient, prepareLocalTx, sendFromLocalAccount } from "./localSend";
import { awaitSuccessfulReceipt } from "./receipts";

/** Named in a refusal, so the sentence says WHICH key could not sign (see `localSend.ts`). */
const RECORDER = "ReputationAdapter: the recorder account";

export interface ReputationAdapterDeps {
  publicClient: PublicClient;
  /** The evaluator key where one is configured, else the job client (`jobs/composition.ts`) — so
   *  this send shares a nonce space, and therefore a lock, with `JobAdapter.complete`. */
  recorderWallet: WalletClient;
  /** The bounded client for the two calls that happen inside the send lock — `sendClientFor(cfg)`
   *  in `clients.ts`. Every composition that SENDS passes it; a read-only one needs none. */
  sendClient?: LocalSendClient;
  registry: Address;
}

export class ReputationAdapter {
  constructor(private readonly d: ReputationAdapterDeps) {}

  /**
   * Record feedback about an agent. Signed by the recorder (evaluator/client) — never the agent
   * itself (the registry blocks self-feedback). Maps a simple score to the on-chain 8-arg
   * giveFeedback.
   *
   * The recorder is an in-process key, so the send takes that key's lock like every other one:
   * simulate outside it, then nonce → signature → broadcast inside, receipt after
   * (`localSend.ts`, `senderLock.ts`). It used to go through `writeContract`, which read its own
   * nonce — and this key also signs `complete`, so two jobs finishing together collided.
   */
  async record(p: {
    agentId: bigint;
    value: number;
    feedbackHash: Hex;
    feedbackURI?: string;
    tag1?: string;
  }): Promise<Hex> {
    const account = this.d.recorderWallet.account;
    if (!account) throw new Error("record: recorderWallet.account is required");
    const args = [
      p.agentId,
      BigInt(p.value),
      0,
      p.tag1 ?? "job",
      "",
      "",
      p.feedbackURI ?? "",
      p.feedbackHash,
    ] as const;
    // The pre-flight, for the decoded revert. Its `request` is not forwarded: the transaction is
    // built from the same call below, so `writeContract` never picks a nonce of its own.
    await this.d.publicClient.simulateContract({
      address: this.d.registry,
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args,
      account,
    });
    const prepared = await prepareLocalTx(this.d.recorderWallet, {
      account,
      to: this.d.registry,
      data: encodeFunctionData({
        abi: reputationRegistryAbi,
        functionName: "giveFeedback",
        args,
      }),
    });
    const h = await sendFromLocalAccount({
      wallet: this.d.recorderWallet,
      via: this.d.sendClient ?? (this.d.publicClient as unknown as LocalSendClient),
      sender: account.address as Address,
      prepared,
      who: RECORDER,
    });
    // Outside the lock: a lock held across a receipt wait stops every other send from this key.
    // And the receipt is READ, not merely awaited — a reverted feedback is not a recorded one
    // (`receipts.ts`), and the saga's step 5 stores what comes back here.
    await awaitSuccessfulReceipt(
      this.d.publicClient,
      h,
      (x) => new ChainTxRevertedError("giveFeedback", x),
    );
    return h;
  }
}
