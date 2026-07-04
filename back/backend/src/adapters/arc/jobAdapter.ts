import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { iErc8183JobAbi } from "../../abis/generated";
import { USDC_TRANSFER_GAS } from "./gas";

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

export interface JobAdapterDeps {
  publicClient: PublicClient;
  clientWallet: WalletClient; // signs createJob / fund
  evaluatorWallet?: WalletClient; // signs complete
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

export class JobAdapter {
  constructor(private readonly d: JobAdapterDeps) {}

  get jobContract(): Address {
    return this.d.jobContract;
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
   */
  async createJob(p: {
    provider: Address;
    evaluator: Address;
    expiredAt: bigint;
    description: string;
    hook?: Address;
  }): Promise<{ jobId: bigint; txHash: Hex }> {
    const { result, request } = await this.d.publicClient.simulateContract({
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
    const txHash = await this.d.clientWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { jobId: result as bigint, txHash };
  }

  /**
   * setBudget — MUST be called by the PROVIDER (the contract enforces msg.sender == job.provider).
   * Callers must pass the providerWallet explicitly; using clientWallet would revert.
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
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
    return h;
  }

  /**
   * approveAndFund — client approves the job contract to pull `amount` USDC, then calls fund().
   * Uses clientWallet throughout.
   */
  async approveAndFund(jobId: bigint, usdc: Address, amount: bigint): Promise<Hex> {
    // Step 1: approve job contract to spend USDC
    const { request: approveReq } = await this.d.publicClient.simulateContract({
      address: usdc,
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [this.d.jobContract, amount],
      account: this.d.clientWallet.account!,
    });
    await this.d.publicClient.waitForTransactionReceipt({
      hash: await this.d.clientWallet.writeContract(approveReq),
    });
    // Step 2: fund the job (pulls USDC via transferFrom into escrow)
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "fund",
      args: [jobId, "0x"],
      account: this.d.clientWallet.account!,
    });
    const h = await this.d.clientWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
    return h;
  }

  /**
   * submit — provider submits the deliverable for a funded job.
   * The contract enforces msg.sender == job.provider, so the caller must pass the providerWallet.
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
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
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
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.jobContract,
      abi: iErc8183JobAbi,
      functionName: "complete",
      args: [jobId, reason, "0x"],
      account: this.d.evaluatorWallet.account!,
    });
    const h = await this.d.evaluatorWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
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
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
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
