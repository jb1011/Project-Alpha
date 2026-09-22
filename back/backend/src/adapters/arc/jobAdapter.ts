import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
} from "viem";
import { iErc8183JobAbi } from "../../abis/generated";
import { ChainTxRevertedError, JobFundRevertedError } from "../../errors";
import { withKeyedLock } from "../../payments/keyedMutex";
import { USDC_TRANSFER_GAS } from "./gas";
import { type LocalSendClient, prepareLocalTx, sendFromLocalAccount } from "./localSend";
import { awaitSuccessfulReceipt } from "./receipts";

/** Minimal ERC-20 approve fragment for the approveAndFund flow. */
const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Minimal ERC-20 allowance fragment — what the fund step reads before it spends it. */
const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * ONE ALLOWANCE UNIT PER CLIENT KEY (`payments/keyedMutex.ts`).
 *
 * An ERC-20 allowance is a single number per (owner, spender) pair, and `approve` SETS it. So
 * "approve then fund" is not two independent transactions: it is a read-modify-write on shared
 * state, and two of them interleaved is the 2026-09-22 incident — approve A, approve B (which
 * overwrote A's), fund A (which spent all of it), fund B (mined at `status: 0x0`).
 *
 * Keyed by the CLIENT ADDRESS, because the allowance belongs to the address, not to the job or
 * the entity: `runJob` is serialised per entity (`jobs/composition.ts`), which is the right lock
 * for the agent's operator key and no lock at all for this — the two jobs were on two different
 * entities and shared one client key.
 *
 * ⚠ A DIFFERENT KEY from the per-signer send lock, which is `sender:<address>`
 * (`senderLock.ts`). Nothing nests on the same key: this unit is the outer one, and the individual
 * broadcasts inside it each take the sender lock at the leaf, as every other send does. It is also
 * the reason the two `simulateContract` pre-flights below mean anything at all — they now run
 * inside the window whose state they are checking.
 */
const allowanceLockKey = (client: Address) => `job-allowance:${client.toLowerCase()}`;

/** Minimal ERC-20 balanceOf fragment for the sweep flow. */
const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Minimal ERC-20 transfer fragment for the sweep flow. */
const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Named in a refusal, so the sentence says WHICH key could not sign (see `localSend.ts`). */
const JOB_CLIENT = "JobAdapter: the job client account";
const JOB_EVALUATOR = "JobAdapter: the evaluator account";

export interface JobAdapterDeps {
  publicClient: PublicClient;
  clientWallet: WalletClient; // signs createJob / fund
  evaluatorWallet?: WalletClient; // signs complete
  /** The bounded client for the two calls that happen inside the send lock — `sendClientFor(cfg)`
   *  in `clients.ts`. Every composition that SENDS passes it; a read-only one needs none. */
  sendClient?: LocalSendClient;
  jobContract: Address;
}

export interface JobResult {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: Address;
  // Note: the submitted deliverable is NOT in the Job struct on-chain.
  // To read it, query the Submitted(jobId, deliverable) event log.
}

/**
 * THE JOB PATH'S SENDS, AND THE TWO KINDS OF KEY THEY USE.
 *
 * `createJob`, `approveAndFund` and `complete` sign with keys this PROCESS holds — the job client
 * and the evaluator — so every one of them goes through the per-signer send lock, exactly as every
 * platform send does (`localSend.ts`, `senderLock.ts`). They used to call `writeContract`, which
 * numbers the transaction itself from a fresh `eth_getTransactionCount`, so two concurrent jobs
 * from one tenant (or a step racing another) signed the same nonce and the node kept one.
 *
 * `setBudget`, `submit` and `transferUsdc` take their wallet from the CALLER: the per-agent enclave
 * or Circle. Those signatures are network calls, the lock must not be held across one, and their
 * nonce space is not ours — so they keep `writeContract` and are deliberately not routed through
 * the lock here.
 */
export class JobAdapter {
  constructor(private readonly d: JobAdapterDeps) {}

  get jobContract(): Address {
    return this.d.jobContract;
  }

  /**
   * The client the in-lock calls use: bounded transport, no retries (`clients.ts`).
   *
   * Falls back to the ordinary client when a composition does not supply one — the read-only
   * adapters, and the tests that never reach a send. Every composition that DOES send passes it,
   * because the fallback carries the app-wide retry budget and that budget is what the lock cannot
   * afford. Same rule, same words, as `ArcAdapter.sendVia`.
   */
  private get sendVia(): LocalSendClient {
    return this.d.sendClient ?? (this.d.publicClient as unknown as LocalSendClient);
  }

  /**
   * ONE SEND FROM ONE OF THIS ADAPTER'S OWN KEYS — the job client or the evaluator.
   *
   * Prepare outside the lock (gas, fees, chain id), then the nonce-critical window inside it: read
   * the pending nonce, sign offline, broadcast. Exactly the platform key's shape, sharing its
   * mechanism rather than copying it (`localSend.ts`, `senderLock.ts`).
   *
   * It replaced `walletClient.writeContract`, which signs AND broadcasts in one call and reads its
   * own nonce on the way: two jobs starting in the same moment both read the node's count, both
   * signed the same number, and the node kept one of the two transactions.
   *
   * ⚠ The RECEIPT WAIT stays with the caller, after this returns. A lock held across it would
   * stop every other send from this key for as long as the chain takes.
   *
   * ⚠ NOT for a wallet the CALLER passes in (`setBudget`, `submit`, `transferUsdc`): those are
   * remote signers (the per-agent enclave, Circle), and a remote signature inside the lock is the
   * one thing it must not hold — see `localSend.ts`.
   */
  private async sendAsLocalKey(
    wallet: WalletClient,
    who: string,
    p: { to: Address; data: Hex; gas?: bigint },
  ): Promise<Hex> {
    const account = wallet.account;
    // viem silently substitutes the zero address for an absent account, which turns a send into a
    // confusing revert (or a simulation that passes against a mock). Refuse loudly instead.
    if (!account) throw new Error(`${who}: no account on the wallet client — refusing to send`);
    const prepared = await prepareLocalTx(wallet, { account, to: p.to, data: p.data, gas: p.gas });
    return sendFromLocalAccount({
      wallet,
      via: this.sendVia,
      sender: account.address as Address,
      prepared,
      who,
    });
  }

  async jobCounter(): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "jobCounter",
    }) as Promise<bigint>;
  }

  /**
   * createJob — client creates a new job.
   *
   * The real contract emits no JobCreated event, so the jobId comes from simulateContract's
   * return value. On a shared, heavily-used counter a concurrent createJob mining between
   * simulate and inclusion could shift the id — acceptable for the demo (our createJobs are
   * infrequent and persisted immediately), flagged as a V2 hardening caveat.
   *
   * The simulate is the pre-flight AND the id; the transaction itself is encoded, prepared and
   * numbered by {sendAsLocalKey}, because `writeContract` would have read its own nonce.
   */
  async createJob(p: {
    provider: Address;
    evaluator: Address;
    expiredAt: bigint;
    description: string;
    hook?: Address;
  }): Promise<{ jobId: bigint; txHash: Hex }> {
    const { result } = await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "createJob",
      args: [
        p.provider,
        p.evaluator,
        p.expiredAt,
        p.description,
        p.hook ?? "0x0000000000000000000000000000000000000000",
      ],
      account: this.d.clientWallet.account!,
    });
    const txHash = await this.sendAsLocalKey(this.d.clientWallet, JOB_CLIENT, {
      to: this.d.jobContract,
      data: encodeFunctionData({
        abi: iErc8183JobAbi,
        functionName: "createJob",
        args: [
          p.provider,
          p.evaluator,
          p.expiredAt,
          p.description,
          p.hook ?? "0x0000000000000000000000000000000000000000",
        ],
      }),
    });
    await this.mined(txHash, "createJob");
    return { jobId: result as bigint, txHash };
  }

  /**
   * Await the receipt and REFUSE one that reverted (`receipts.ts`).
   *
   * Every send in this class ends here, and the step is the name that reaches the caller — never
   * a message from the node.
   */
  private mined(txHash: Hex, step: string): Promise<void> {
    return awaitSuccessfulReceipt(
      this.d.publicClient,
      txHash,
      (h) => new ChainTxRevertedError(step, h),
    );
  }

  /**
   * setBudget — MUST be called by the PROVIDER (the contract enforces msg.sender == job.provider).
   * Callers must pass the providerWallet explicitly; using clientWallet would revert.
   *
   * The provider's wallet is the caller's (enclave or Circle): a REMOTE signer, so this send is not
   * under our send lock — see the class note.
   */
  async setBudget(jobId: bigint, amount: bigint, providerWallet: WalletClient): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "setBudget",
      args: [jobId, amount, "0x"],
      account: providerWallet.account!,
    });
    const h = await providerWallet.writeContract(request);
    await this.mined(h, "setBudget");
    return h;
  }

  /**
   * approveAndFund — client approves the job contract to pull `amount` USDC, then calls fund().
   * Uses clientWallet throughout, and therefore the job client's send lock: TWO transactions, each
   * numbered inside its own locked window, with the approve's receipt awaited between them.
   *
   * ⚠ BOTH RECEIPTS ARE READ, not merely awaited. A reverted transaction gets a receipt too, and
   * the caller books an outflow off the value this returns — see `receipts.ts` and `runJob.ts`.
   *
   * ⚠ THE TWO SENDS ARE ONE UNIT, per client key — see {allowanceLockKey}. Two jobs funding at
   * once are two writers to one allowance, and interleaving them is what reverted a fund.
   */
  async approveAndFund(jobId: bigint, usdc: Address, amount: bigint): Promise<Hex> {
    const client = this.d.clientWallet.account!.address as Address;
    return withKeyedLock(allowanceLockKey(client), () => this.approveThenFund(jobId, usdc, amount));
  }

  /** The unit itself: approve, then fund what the approve granted. Never called unlocked. */
  private async approveThenFund(jobId: bigint, usdc: Address, amount: bigint): Promise<Hex> {
    // Step 1: approve job contract to spend USDC
    await this.d.publicClient.simulateContract({
      address: usdc,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [this.d.jobContract, amount],
      account: this.d.clientWallet.account!,
    });
    const approveHash = await this.sendAsLocalKey(this.d.clientWallet, JOB_CLIENT, {
      to: usdc,
      data: encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [this.d.jobContract, amount],
      }),
    });
    await awaitSuccessfulReceipt(
      this.d.publicClient,
      approveHash,
      (h) => new JobFundRevertedError("approve", h, jobId),
    );
    // Step 2: fund the job (pulls USDC via transferFrom into escrow). Simulated only now: before
    // the approve is mined it would revert on the allowance.
    await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "fund",
      args: [jobId, "0x"],
      account: this.d.clientWallet.account!,
    });
    // BELT AND BRACES, and cheap: the allowance this fund is about to spend, read from the chain
    // rather than assumed from the approve above. A mis-set or already-spent allowance then costs
    // a refusal instead of a reverted transaction — the pre-flight cannot be trusted to catch it,
    // because the incident's allowance was still there when the pre-flight ran.
    const allowance = (await this.d.publicClient.readContract({
      address: usdc,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [this.d.clientWallet.account!.address as Address, this.d.jobContract],
    })) as bigint;
    if (allowance < amount)
      throw new JobFundRevertedError("approve", approveHash, jobId, "allowance");
    const h = await this.sendAsLocalKey(this.d.clientWallet, JOB_CLIENT, {
      to: this.d.jobContract,
      data: encodeFunctionData({ abi: iErc8183JobAbi, functionName: "fund", args: [jobId, "0x"] }),
    });
    await awaitSuccessfulReceipt(
      this.d.publicClient,
      h,
      (x) => new JobFundRevertedError("fund", x, jobId),
    );
    return h;
  }

  /**
   * submit — provider submits the deliverable for a funded job.
   * The contract enforces msg.sender == job.provider, so the caller must pass the providerWallet.
   * A remote signer's send, so not under our send lock — see the class note.
   */
  async submit(jobId: bigint, deliverable: Hex, providerWallet: WalletClient): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "submit",
      args: [jobId, deliverable, "0x"],
      account: providerWallet.account!,
    });
    const h = await providerWallet.writeContract(request);
    await this.mined(h, "submit");
    return h;
  }

  /**
   * complete — evaluator marks the job complete, releasing escrowed USDC to the provider.
   * Requires evaluatorWallet to be configured in deps.
   */
  async complete(jobId: bigint, reason: Hex): Promise<Hex> {
    if (!this.d.evaluatorWallet) {
      throw new Error("complete: evaluatorWallet not configured");
    }
    await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "complete",
      args: [jobId, reason, "0x"],
      account: this.d.evaluatorWallet.account!,
    });
    const h = await this.sendAsLocalKey(this.d.evaluatorWallet, JOB_EVALUATOR, {
      to: this.d.jobContract,
      data: encodeFunctionData({
        abi: iErc8183JobAbi,
        functionName: "complete",
        args: [jobId, reason, "0x"],
      }),
    });
    await this.mined(h, "complete");
    return h;
  }

  /**
   * usdcBalanceOf — read the current USDC balance of `owner` on-chain.
   * Used in Step 4.5 of the runJob saga to sweep the operator's actual balance
   * rather than the static budget (which may have been partially consumed by gas).
   */
  async usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: usdc,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>;
  }

  /**
   * transferUsdc — sweep earned USDC from the provider's wallet to the treasury.
   * Signs and broadcasts a plain ERC-20 transfer using the given wallet (typically
   * the per-agent Turnkey enclave key that holds the released escrow balance).
   */
  async transferUsdc(
    wallet: WalletClient,
    usdc: Address,
    to: Address,
    amount: bigint,
  ): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [to, amount],
      account: wallet.account!,
    });
    // Explicit gas (see USDC_TRANSFER_GAS): sweeps ~the provider EOA's entire USDC balance, so viem's
    // fee-fielded estimateGas would otherwise reserve it all and revert.
    const h = await wallet.writeContract({ ...request, gas: USDC_TRANSFER_GAS });
    await this.mined(h, "transferUsdc");
    return h;
  }

  /**
   * clientAddress — the address of the wallet that signs createJob and approveAndFund.
   * Persisted on the JobRecord in Step 1 of the runJob saga.
   */
  clientAddress(): Address {
    return this.d.clientWallet.account!.address;
  }

  /**
   * evaluatorAddress — the address of the wallet that signs complete.
   * Persisted on the JobRecord in Step 1 of the runJob saga.
   * Throws if no evaluatorWallet was provided in deps.
   */
  evaluatorAddress(): Address {
    if (!this.d.evaluatorWallet) {
      throw new Error("evaluatorAddress: evaluatorWallet not configured");
    }
    return this.d.evaluatorWallet.account!.address;
  }

  async getJob(jobId: bigint): Promise<JobResult> {
    const j = (await this.d.publicClient.readContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "getJob",
      args: [jobId],
    })) as {
      id: bigint;
      client: Address;
      provider: Address;
      evaluator: Address;
      description: string;
      budget: bigint;
      expiredAt: bigint;
      status: number;
      hook: Address;
    };
    return {
      id: j.id,
      client: j.client,
      provider: j.provider,
      evaluator: j.evaluator,
      description: j.description,
      budget: j.budget,
      expiredAt: j.expiredAt,
      status: j.status,
      hook: j.hook,
    };
  }
}
