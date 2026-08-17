import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  isAddressEqual,
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
   * PER-AGENT relay routing. The controller is the manager of agents created THROUGH it; every
   * agent minted before the cutover still has the old EOA as its immutable `manager`, and a vault
   * only ever obeys its own manager. So "controller mode" is not a global switch — it is a
   * property of the AGENT, read from the manager this deployment persisted when it was created.
   *
   * Relay when a controller is configured AND (no agent manager was supplied — deployment-level
   * calls like createEntity, where the doors force the controller — OR the agent's manager IS the
   * controller). Otherwise go direct, EVEN IN CONTROLLER MODE: that is the legacy agent's only
   * working path, and relaying its policy update would revert `NotManager` on the vault.
   */
  private relayTargetFor(agentManager?: Address): Address | undefined {
    const controller = this.d.controller;
    if (!controller) return undefined;
    if (agentManager && !isAddressEqual(agentManager, controller)) return undefined;
    return controller;
  }

  /**
   * The ONE seam every manager-signed, role-gated write goes through, and the only place that knows
   * about the controller. Returns the broadcast tx hash WITHOUT awaiting a receipt (callers that
   * need confirmation await it themselves, exactly as they did before).
   *
   * Direct path (no controller, or a legacy agent — see {relayTargetFor}): unchanged —
   * simulateContract against the target, then write the simulated request.
   *
   * Relayed path: the same calldata is encoded, the 20-byte target is appended (Euler relay
   * encoding — see relay.ts) and the whole thing is sent as a RAW transaction to the controller,
   * which checks `hasRole(selector, executor)` and forwards. simulateContract cannot express that
   * (the trailing target is not part of any ABI), so the preflight is an `eth_estimateGas` on the
   * exact bytes we are about to send: it reverts with the target's bubbled error before we spend
   * gas, AND its result is the gas limit we send with — one node round-trip doing both jobs, where
   * an `eth_call` preflight had viem execute the transaction a second time to estimate.
   *
   * NOT for signer-direct calls: fundTreasury (a plain USDC transfer) and the liveRunner gas seeds
   * are not role-gated and must keep coming straight from the signing key.
   */
  private async sendManagerCall(p: {
    target: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    /** The agent's PERSISTED on-chain manager. Omit for calls that belong to no single agent. */
    agentManager?: Address;
  }): Promise<Hex> {
    // Every path below signs/simulates AS this account. viem silently substitutes the zero address
    // for an absent account, which turns an onlyManager write into a confusing revert (or, worse,
    // a simulation that passes against a mock) — so refuse loudly instead.
    const account = this.d.managerWallet.account;
    if (!account)
      throw new Error(
        "ArcAdapter: manager wallet has no account (hoist an account on the WalletClient) — refusing to send/simulate as the zero address",
      );

    const controller = this.relayTargetFor(p.agentManager);
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
    let gas: bigint;
    try {
      gas = await this.d.publicClient.estimateGas({ account, to: controller, data });
    } catch (err) {
      // Only a REVERT is re-dressed with the decoded reason; a transport failure is rethrown
      // untouched so an RPC outage never reads as "reverted in simulation" (see relay.ts).
      throw relayRevertError(err, { ...p, controller });
    }
    return this.d.managerWallet.sendTransaction({
      to: controller,
      data,
      gas,
      account,
      chain: this.d.managerWallet.chain,
    });
  }

  /** {sendManagerCall} + await the receipt — the tail four of the five relayed sites repeat. */
  private async sendManagerCallConfirmed(p: {
    target: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    agentManager?: Address;
  }): Promise<Hex> {
    const hash = await this.sendManagerCall(p);
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
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
    return this.confirmCreateEntity(txHash, p.manager);
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
      // The manager being minted IS the routing key: in controller mode both onboard doors force
      // it to the controller, so this relays. Anything else takes the direct path and fails loudly
      // at the factory (M4: `ManagerMustBeOwner`) instead of quietly minting a rogue-managed body.
      agentManager: p.manager,
    });
  }

  /**
   * Await the createEntity receipt and read the ids from its events. Idempotent: re-reading the same
   * mined tx yields the same agentId, which is exactly what the saga relies on to adopt an in-flight
   * mint on resume rather than broadcasting a second one.
   */
  async confirmCreateEntity(txHash: Hex, agentManager?: Address): Promise<CreateEntityResult> {
    const receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });

    // Controller mode puts other contracts' logs in this receipt (the controller's own `Relayed`,
    // plus anything the relayed call touches), and EntityCreated(uint256,address,address) is not a
    // signature only our factory can emit. Read the ids from the CONFIGURED FACTORY's logs only.
    const factoryLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === this.d.factory.toLowerCase(),
    );
    // One pass over the logs for both events; viem still types each `.args` precisely because the
    // event names are a literal union, so the result is discriminated on `eventName`.
    const events = parseEventLogs({
      abi: legalManagerFactoryAbi,
      eventName: ["EntityCreated", "TreasuryCreated"],
      logs: factoryLogs,
    });
    const created = events.find((e) => e.eventName === "EntityCreated");
    const treasuryEvt = events.find((e) => e.eventName === "TreasuryCreated");
    if (!created || !treasuryEvt)
      throw new Error("createEntity: EntityCreated/TreasuryCreated not emitted");

    // When the create was RELAYED, the manager topic MUST be the controller — that is the whole
    // point of the design (the controller is the immutable manager + NFT owner of every new
    // agent). A mismatch means this deployment minted through the OLD factory (or against the
    // wrong controller), and every later step — bind, metadata, policy — would fail obscurely
    // against a vault whose manager is an address we no longer sign as. Fail here, visibly.
    //
    // Gated on the SAME predicate the send used (not merely "a controller is configured"), so a
    // record broadcast before the cutover and resumed after it confirms against the manager it was
    // actually minted with, instead of throwing forever on a mismatch it can never resolve.
    const relayed = this.relayTargetFor(agentManager);
    if (relayed && !isAddressEqual(created.args.manager, relayed))
      throw new Error(
        `createEntity: EntityCreated manager ${created.args.manager} is not the configured controller ${relayed} — check FACTORY_ADDRESS/CONTROLLER_ADDRESS (is this the controller-owned factory?)`,
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
    /** The agent's persisted manager = the NFT owner the registry gates on. */
    agentManager?: Address;
  }): Promise<Hex> {
    return this.sendManagerCallConfirmed({
      target: this.d.identityRegistry,
      abi: iIdentityRegistryAbi as Abi,
      functionName: "setAgentWallet",
      args: [p.agentId, p.newWallet, p.deadline, p.signature],
      agentManager: p.agentManager,
    });
  }

  /** Set an on-chain metadata key/value on the agent NFT (manager-gated: owner-or-approved).
   *  ENSIP-25 uses key "ens" carrying the UTF-8 bytes of the agent's ENS name — the reverse half of
   *  the bidirectional binding (the ENS name's agent-registration record is the forward half).
   *  `agentManager` is the agent's persisted manager: a legacy agent's NFT is still owned by the
   *  old EOA, so its metadata write must NOT be relayed. */
  async setAgentMetadata(
    agentId: bigint,
    key: string,
    value: Hex,
    agentManager?: Address,
  ): Promise<Hex> {
    return this.sendManagerCallConfirmed({
      target: this.d.identityRegistry,
      abi: iIdentityRegistryAbi as Abi,
      functionName: "setMetadata",
      args: [agentId, key, value],
      agentManager,
    });
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

  /** Schedule a treasury policy change (manager-gated, timelocked). Returns the on-chain tx hash.
   *  `agentManager` is the vault's IMMUTABLE manager as persisted at creation — the vault obeys
   *  nobody else, so it decides whether this call relays or goes direct. */
  async schedulePolicyUpdate(
    treasury: Address,
    p: { newCap: bigint; newPeriod: bigint; allowlistOn: boolean; newPayout: Address },
    agentManager?: Address,
  ): Promise<Hex> {
    return this.sendManagerCallConfirmed({
      target: treasury,
      abi: agentTreasuryAbi as Abi,
      functionName: "schedulePolicyUpdate",
      args: [p.newCap, p.newPeriod, p.allowlistOn, p.newPayout],
      agentManager,
    });
  }

  /** Execute a previously-scheduled policy change once its timelock has elapsed (manager-gated). */
  async executePolicyUpdate(
    treasury: Address,
    policyId: Hex,
    agentManager?: Address,
  ): Promise<Hex> {
    return this.sendManagerCallConfirmed({
      target: treasury,
      abi: agentTreasuryAbi as Abi,
      functionName: "executePolicyUpdate",
      args: [policyId],
      agentManager,
    });
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
