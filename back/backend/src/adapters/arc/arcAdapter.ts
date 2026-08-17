import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
} from "../../abis/generated";
import type { TreasuryConfig } from "../../types";
import { USDC_TRANSFER_GAS } from "./gas";
import { appendRelayTarget, relayRevertError } from "./relay";

/** Minimal ERC-20 transfer fragment for funding the treasury vault with USDC. */
const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Minimal EIP-5267 fragment so we can read any registry's EIP-712 domain without its full ABI. */
const EIP712_DOMAIN_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

export interface ArcAdapterDeps {
  publicClient: PublicClient;
  managerWallet: WalletClient; // signs/sends as the manager (Factory owner)
  operatorWallet?: WalletClient; // signs/sends as the operator (the enclave); required for fundOperator/spend
  chainId: number; // reserved for the M4 setAgentWallet EIP-712 domain (see walletSet.ts)
  factory: Address;
  identityRegistry: Address;
  /** NoviController (design/2026-08-13-novi-controller-design.md). Present => the on-chain manager
   *  identity is this contract and every ROLE-GATED manager call is relayed through it
   *  (`data = calldata ++ target20`), with managerWallet demoted to executor/tx sender. Absent =>
   *  legacy direct calls, byte-identical to pre-controller behavior. */
  controller?: Address;
}

export interface CreateEntityParams {
  manager: Address;
  guardian: Address;
  operator: Address;
  amendmentDelay: bigint;
  metadataURI: string;
  ein: string;
  formationDate: number;
  operatingAgreementHash: Hex;
  treasury: TreasuryConfig;
}

export interface CreateEntityResult {
  agentId: bigint;
  proxy: Address;
  treasury: Address;
  txHash: Hex;
}

export class ArcAdapter {
  constructor(private readonly d: ArcAdapterDeps) {}

  get chainId(): number {
    return this.d.chainId;
  }
  get identityRegistry(): Address {
    return this.d.identityRegistry;
  }

  /**
   * The ONE seam every manager-signed, role-gated write goes through, and the only place that knows
   * about the controller. Returns the broadcast tx hash WITHOUT awaiting a receipt (callers that
   * need confirmation await it themselves, exactly as they did before).
   *
   * Direct mode (no controller): unchanged — simulateContract against the target, then write the
   * simulated request.
   *
   * Controller mode: the same calldata is encoded, the 20-byte target is appended (Euler relay
   * encoding — see relay.ts) and the whole thing is sent as a RAW transaction to the controller,
   * which checks `hasRole(selector, executor)` and forwards. simulateContract cannot express that
   * (the trailing target is not part of any ABI), so we eth_call the exact bytes we are about to
   * send: the controller bubbles the target's revert verbatim, and we decode it against the
   * target's ABI so a relay mistake names itself instead of arriving as a hex blob.
   *
   * NOT for signer-direct calls: fundTreasury (a plain USDC transfer) and the liveRunner gas seeds
   * are not role-gated and must keep coming straight from the signing key.
   */
  private async sendManagerCall(p: {
    target: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  }): Promise<Hex> {
    const account = this.d.managerWallet.account ?? undefined;
    const controller = this.d.controller;
    if (!controller) {
      const { request } = await this.d.publicClient.simulateContract({
        address: p.target,
        abi: p.abi,
        functionName: p.functionName,
        args: p.args,
        account,
      });
      return this.d.managerWallet.writeContract(request);
    }

    const data = appendRelayTarget(
      encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args }),
      p.target,
    );
    try {
      await this.d.publicClient.call({ to: controller, data, account });
    } catch (err) {
      throw relayRevertError(err, { ...p, controller });
    }
    return this.d.managerWallet.sendTransaction({
      to: controller,
      data,
      account: account!,
      chain: this.d.managerWallet.chain,
    });
  }

  /**
   * Call factory.createEntity. The result ids are read back from the EntityCreated/TreasuryCreated
   * events of the mined receipt (the on-chain source of truth) rather than from simulate's return:
   * the registry assigns agentId from a monotonic counter, so if another register/createEntity is
   * mined between our simulate and our inclusion, simulate's predicted id would be stale. simulate is
   * still run first to surface reverts with a decoded reason before broadcasting.
   *
   * One-shot composition of broadcast + confirm. The saga uses the two halves directly so it can
   * persist the broadcast tx hash BEFORE awaiting the receipt (closing the create->persist double-mint
   * window); callers that don't need that seam can keep using this single call unchanged.
   */
  async createEntity(p: CreateEntityParams): Promise<CreateEntityResult> {
    const txHash = await this.broadcastCreateEntity(p);
    return this.confirmCreateEntity(txHash);
  }

  /**
   * Broadcast factory.createEntity and return the tx hash WITHOUT awaiting the receipt. simulate runs
   * first to surface a decoded revert before we send. Persist the returned hash before calling
   * confirmCreateEntity so a crash in between can adopt this tx on resume instead of re-minting.
   */
  async broadcastCreateEntity(p: CreateEntityParams): Promise<Hex> {
    const args = [
      p.manager,
      p.guardian,
      p.operator,
      p.amendmentDelay,
      p.metadataURI,
      p.ein,
      BigInt(p.formationDate),
      p.operatingAgreementHash,
      {
        usdc: p.treasury.usdc,
        payoutAddress: p.treasury.payoutAddress,
        cap: p.treasury.cap,
        period: p.treasury.period,
        allowlistEnabled: p.treasury.allowlistEnabled,
      },
    ] as const;

    return this.sendManagerCall({
      target: this.d.factory,
      abi: legalManagerFactoryAbi as Abi,
      functionName: "createEntity",
      args,
    });
  }

  /**
   * Await the createEntity receipt and read the ids from its events. Idempotent: re-reading the same
   * mined tx yields the same agentId, which is exactly what the saga relies on to adopt an in-flight
   * mint on resume rather than broadcasting a second one.
   */
  async confirmCreateEntity(txHash: Hex): Promise<CreateEntityResult> {
    const receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Controller mode puts other contracts' logs in this receipt (the controller's own `Relayed`,
    // plus anything the relayed call touches), and EntityCreated(uint256,address,address) is not a
    // signature only our factory can emit. Read the ids from the CONFIGURED FACTORY's logs only.
    const factoryLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === this.d.factory.toLowerCase(),
    );
    // Narrow to a single event name each so viem types `.args` precisely (no casts needed).
    const [created] = parseEventLogs({
      abi: legalManagerFactoryAbi,
      eventName: "EntityCreated",
      logs: factoryLogs,
    });
    const [treasuryEvt] = parseEventLogs({
      abi: legalManagerFactoryAbi,
      eventName: "TreasuryCreated",
      logs: factoryLogs,
    });
    if (!created || !treasuryEvt)
      throw new Error("createEntity: EntityCreated/TreasuryCreated not emitted");

    // In controller mode the manager topic MUST be the controller — that is the whole point of the
    // design (the controller is the immutable manager + NFT owner of every new agent). A mismatch
    // means this deployment minted through the OLD factory (or against the wrong controller), and
    // every later step — bind, metadata, policy — would fail obscurely against a vault whose
    // manager is an address we no longer sign as. Fail here, where the cause is still visible.
    if (this.d.controller && created.args.manager.toLowerCase() !== this.d.controller.toLowerCase())
      throw new Error(
        `createEntity: EntityCreated manager ${created.args.manager} is not the configured controller ${this.d.controller} — check FACTORY_ADDRESS/CONTROLLER_ADDRESS (is this the controller-owned factory?)`,
      );

    return {
      agentId: created.args.agentId,
      proxy: created.args.proxy,
      treasury: treasuryEvt.args.treasury,
      txHash,
    };
  }

  /**
   * Compute a safe deadline from CHAIN time (not local clock): block.timestamp + 180s.
   * The LIVE registry requires now <= deadline <= now + 300s (its MAX_DEADLINE_DELAY) — verified
   * empirically against 0x8004…BD9e on 2026-06-16, which reverts "deadline too far" beyond 300s.
   * (An earlier note assumed a 1h window; that was wrong and would make the bind revert.) 180s sits
   * inside the window with margin above mining latency (the lower "expired" bound) and below the cap.
   */
  async walletSetDeadline(): Promise<bigint> {
    const block = await this.d.publicClient.getBlock({ blockTag: "latest" });
    return block.timestamp + 180n;
  }

  /**
   * Bind the agent's wallet. Caller = manager (NFT owner); signature must be from `newWallet`.
   * Note: the canonical registry's AgentWalletSet carries no nonce, so a signature is replayable
   * by an authorized caller until its deadline — keep deadlines short and treat each as one-shot.
   * (Contract-level property; same class as the deferred policy-nonce item.)
   */
  async setAgentWallet(p: {
    agentId: bigint;
    newWallet: Address;
    deadline: bigint;
    signature: Hex;
  }): Promise<Hex> {
    const txHash = await this.sendManagerCall({
      target: this.d.identityRegistry,
      abi: iIdentityRegistryAbi as Abi,
      functionName: "setAgentWallet",
      args: [p.agentId, p.newWallet, p.deadline, p.signature],
    });
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Set an on-chain metadata key/value on the agent NFT (manager-gated: owner-or-approved).
   *  ENSIP-25 uses key "ens" carrying the UTF-8 bytes of the agent's ENS name — the reverse half of
   *  the bidirectional binding (the ENS name's agent-registration record is the forward half). */
  async setAgentMetadata(agentId: bigint, key: string, value: Hex): Promise<Hex> {
    const txHash = await this.sendManagerCall({
      target: this.d.identityRegistry,
      abi: iIdentityRegistryAbi as Abi,
      functionName: "setMetadata",
      args: [agentId, key, value],
    });
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Read an on-chain metadata value (ENSIP-25 verifier side): bytes for key on the agent NFT. */
  getAgentMetadata(agentId: bigint, key: string): Promise<Hex> {
    return this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "getMetadata",
      args: [agentId, key],
    }) as Promise<Hex>;
  }

  /** Schedule a treasury policy change (manager-gated, timelocked). Returns the on-chain tx hash. */
  async schedulePolicyUpdate(
    treasury: Address,
    p: { newCap: bigint; newPeriod: bigint; allowlistOn: boolean; newPayout: Address },
  ): Promise<Hex> {
    const hash = await this.sendManagerCall({
      target: treasury,
      abi: agentTreasuryAbi as Abi,
      functionName: "schedulePolicyUpdate",
      args: [p.newCap, p.newPeriod, p.allowlistOn, p.newPayout],
    });
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Execute a previously-scheduled policy change once its timelock has elapsed (manager-gated). */
  async executePolicyUpdate(treasury: Address, policyId: Hex): Promise<Hex> {
    const hash = await this.sendManagerCall({
      target: treasury,
      abi: agentTreasuryAbi as Abi,
      functionName: "executePolicyUpdate",
      args: [policyId],
    });
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Optional v1 step: top up the treasury vault with ERC-20 USDC from the manager wallet. */
  async fundTreasury(p: { usdc: Address; treasury: Address; amount: bigint }): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      address: p.usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [p.treasury, p.amount],
      account: this.d.managerWallet.account!,
    });
    // Explicit gas (see USDC_TRANSFER_GAS): the manager wallet is well-funded today, but this keeps
    // the near-full-balance estimateGas footgun from biting if it ever runs low.
    const txHash = await this.d.managerWallet.writeContract({ ...request, gas: USDC_TRANSFER_GAS });
    await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Operator pushes USDC from the treasury to the operator's own EOA, within the cap (onlyOperator). */
  async fundOperator(treasury: Address, amount: bigint): Promise<Hex> {
    const operatorWallet = this.requireOperatorWallet();
    const { request } = await this.d.publicClient.simulateContract({
      account: operatorWallet.account ?? undefined,
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "fundOperator",
      args: [amount],
    });
    const hash = await operatorWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Operator forwards USDC from its own EOA to the bounded pocket EOA (a plain ERC-20 transfer). */
  async operatorTransferUsdc(usdc: Address, to: Address, amount: bigint): Promise<Hex> {
    const operatorWallet = this.requireOperatorWallet();
    const { request } = await this.d.publicClient.simulateContract({
      account: operatorWallet.account ?? undefined,
      address: usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [to, amount],
    });
    // Explicit gas so viem skips the fee-fielded eth_estimateGas footgun (see USDC_TRANSFER_GAS);
    // simulateContract above uses a plain eth_call, which is unaffected.
    const hash = await operatorWallet.writeContract({ ...request, gas: USDC_TRANSFER_GAS });
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  private requireOperatorWallet(): WalletClient {
    if (!this.d.operatorWallet) {
      throw new Error(
        "operatorWallet not configured: fundOperator/operatorTransferUsdc need the operator (enclave) signer",
      );
    }
    return this.d.operatorWallet;
  }

  /**
   * Read the registry's EIP-712 domain (EIP-5267) so callers can source name/version from chain
   * instead of hardcoding them — pass these into buildWalletSetTypedData before signing.
   */
  async eip712Domain(): Promise<{ name: string; version: string }> {
    const res = await this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: EIP712_DOMAIN_ABI,
      functionName: "eip712Domain",
    });
    // EIP-5267 tuple: [fields, name, version, chainId, verifyingContract, salt, extensions]
    return { name: res[1], version: res[2] };
  }

  ownerOf(agentId: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }) as Promise<Address>;
  }

  getAgentWallet(agentId: bigint): Promise<Address> {
    return this.d.publicClient.readContract({
      address: this.d.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    }) as Promise<Address>;
  }

  treasuryAvailable(treasury: Address): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "available",
    }) as Promise<bigint>;
  }

  /** Real ERC-20 USDC balance held by an address (e.g. the treasury vault) — the actual funds on hand. */
  usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: usdc,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>;
  }

  /** Guardian kill-switch state: true once the guardian has paused the vault (blocks all spends). */
  treasuryPaused(treasury: Address): Promise<boolean> {
    return this.d.publicClient.readContract({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "paused",
    }) as Promise<boolean>;
  }

  /** Whether the recipient allowlist is enforced (the master switch; per-entry membership is isAllowed). */
  treasuryAllowlistEnabled(treasury: Address): Promise<boolean> {
    return this.d.publicClient.readContract({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "allowlistEnabled",
    }) as Promise<boolean>;
  }

  /** Per-recipient allowlist membership (`isAllowed(address)` on the vault — not `allowlist`). */
  treasuryIsAllowed(treasury: Address, who: Address): Promise<boolean> {
    return this.d.publicClient.readContract({
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "isAllowed",
      args: [who],
    }) as Promise<boolean>;
  }

  legalStatus(proxy: Address): Promise<number> {
    return this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "status",
    }) as Promise<number>;
  }
}
