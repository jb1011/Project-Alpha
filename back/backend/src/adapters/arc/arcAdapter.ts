import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type Transport,
  type WalletClient,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  parseTransaction,
} from "viem";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
} from "../../abis/generated";
import { BroadcastUnconfirmedError } from "../../errors";
import type { TreasuryConfig } from "../../types";
import { USDC_TRANSFER_GAS } from "./gas";
import {
  type LocalSendClient,
  type LocalWallet,
  type PreparedLocalTx,
  localSigner,
  pendingNonceOf,
  prepareLocalTx,
  sendFromLocalAccount,
} from "./localSend";
import { appendRelayTarget, relayRevertError } from "./relay";
import { nextSenderNonce, noteSenderBroadcast } from "./senderLock";

/**
 * How long a manager-call receipt is waited for before the caller is told to come back later.
 *
 * See `waitForManagerReceipt`. Exported so the anchor loop's tests and the runbook name the same
 * number the adapter uses.
 */
export const MANAGER_RECEIPT_TIMEOUT_MS = 30_000;

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

/** A wallet client that is known to carry the platform account — the shape the sign path needs. */
type PlatformWallet = LocalWallet;

/** A platform transaction request with everything but the nonce filled in. */
type PreparedPlatformTx = PreparedLocalTx;

/**
 * A treasury top-up with everything fetched except its nonce — the result of
 * {ArcAdapter.prepareFundTreasury} and the input to {ArcAdapter.signFundTreasury}.
 *
 * A SUPERSET of the transfer it was asked for: the caller records the amount that moved, and it
 * should read it off the same object it signs rather than carrying two copies of one fact.
 */
export interface PreparedFundTransfer {
  usdc: Address;
  treasury: Address;
  amount: bigint;
  /** The viem request: to, data, gas, fees, chain id. No nonce — that is the locked step. */
  request: PreparedPlatformTx;
}

/** The two calls that happen INSIDE the send lock (`localSend.ts`), under the platform's name. */
export type PlatformSendClient = LocalSendClient;

export interface ArcAdapterDeps {
  publicClient: PublicClient;
  managerWallet: WalletClient; // signs/sends as the manager (Factory owner)
  /** The bounded client for the two in-lock calls — `sendClientFor(cfg)` in `clients.ts`. Every
   *  composition that SENDS as the platform passes it; read-only adapters need none. */
  sendClient?: PlatformSendClient;
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
   * The address that signs and pays for every platform send, or undefined when this adapter was
   * built for READS ONLY (several compositions pass no manager wallet at all).
   *
   * It is the sender lock's key, exposed because the funding saga's nonce-critical window spans
   * three calls — sign, persist, send — so the lock there is the CALLER's (see {signFundTreasury}).
   */
  get platformAddress(): Address | undefined {
    return this.d.managerWallet?.account?.address;
  }

  /**
   * A platform transaction with everything decided EXCEPT its nonce.
   *
   * This is the slow half, and it is deliberately outside the lock: gas estimation, fee estimation
   * and the chain id are node round trips, and while the lock is held every other platform send
   * waits on them. `parameters` is viem's default list MINUS `nonce` — picking the nonce is the
   * locked step, and asking for it here would both waste a call and pick it in the wrong place.
   *
   * An explicit `gas` (the Arc `USDC_TRANSFER_GAS` footgun fix, and the relay's estimate) is passed
   * straight through, so viem skips the estimate exactly as it did before.
   */
  private prepareAsPlatform(p: {
    account: Account;
    to: Address;
    data?: Hex;
    value?: bigint;
    gas?: bigint;
  }): Promise<PreparedPlatformTx> {
    return prepareLocalTx(this.d.managerWallet, p);
  }

  /**
   * THE CHOKEPOINT: the only place a platform transaction is numbered and put on the wire.
   *
   * One send at a time per signing key, each with a nonce from one ledger (see senderLock.ts): two
   * sends that read the node's count independently get the same answer and claim the same nonce,
   * and one of them is then rejected or silently replaced.
   *
   * INSIDE the lock, three things and exactly two RPCs: read the pending nonce, sign (offline — the
   * platform account is a local key), hand the bytes to the node. Everything else is outside it —
   * the simulate/estimate preflight and the whole of {prepareAsPlatform} before, the receipt wait
   * after — because the lock is head-of-line blocking for every platform send, so its worst case is
   * everyone's worst case. Both RPCs go through the bounded client (`clients.ts`) for the same
   * reason.
   *
   * The signature goes STRAIGHT TO THE ACCOUNT rather than through `walletClient.signTransaction`,
   * which asks the node for the chain id first — unconditionally, before it looks at whether it
   * needs it (viem 2.52 `actions/wallet/signTransaction.ts`) — and that would be a third call
   * inside the window. The prepared request already carries `chainId`, and the chain's own
   * serializer is handed over exactly as the wallet action would.
   *
   * ⚠ LEAF ONLY. The lock is not reentrant, so nothing here may take it again for the same signer —
   * which is why no method in this class calls another method's send.
   */
  private sendAsPlatform(sender: Address, prepared: PreparedPlatformTx): Promise<Hex> {
    // ⚠ ASSUMES AN IN-PROCESS KEY — `localSend.ts` refuses anything else, and says why there.
    return sendFromLocalAccount({
      wallet: this.d.managerWallet,
      via: this.sendVia,
      sender,
      prepared,
      who: "ArcAdapter: the platform account",
    });
  }

  /** What a NEW transaction from this sender would be numbered, before our own floor is applied.
   *  `pending`, so it counts transactions of ours the chain has accepted but not yet mined. */
  private pendingNonce(sender: Address): Promise<number> {
    return pendingNonceOf(this.sendVia, sender);
  }

  /**
   * The client the in-lock calls use: bounded transport, no retries (`clients.ts`).
   *
   * Falls back to the ordinary client when a composition does not supply one — the read-only
   * adapters, and the tests that never reach a send. Every composition that DOES send passes it,
   * because the fallback carries the app-wide retry budget and that budget is what the lock cannot
   * afford.
   */
  private get sendVia(): PlatformSendClient {
    return this.d.sendClient ?? this.d.publicClient;
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
   * Direct path (no controller, or a legacy agent — see {relayTargetFor}): simulateContract against
   * the target for the decoded revert, then the same call, encoded, prepared and sent.
   *
   * Relayed path: the same calldata is encoded, the 20-byte target is appended (Euler relay
   * encoding — see relay.ts) and the whole thing is sent as a RAW transaction to the controller,
   * which checks `hasRole(selector, executor)` and forwards. simulateContract cannot express that
   * (the trailing target is not part of any ABI), so the preflight is an `eth_estimateGas` on the
   * exact bytes we are about to send: it reverts with the target's bubbled error before we spend
   * gas, AND its result is the gas limit we send with — one node round-trip doing both jobs, where
   * an `eth_call` preflight had viem execute the transaction a second time to estimate.
   *
   * NOT for signer-direct calls: the treasury top-up (a plain USDC transfer) and the liveRunner gas seeds
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

    const calldata = encodeFunctionData({
      abi: p.abi,
      functionName: p.functionName,
      args: p.args,
    });
    const controller = this.relayTargetFor(p.agentManager);
    if (!controller) {
      // The preflight, and the only reason a revert reaches the caller decoded. Its returned
      // `request` is no longer forwarded verbatim — the transaction is built from the same encoded
      // call below — because `writeContract` would estimate gas and fees INSIDE the lock.
      await this.d.publicClient.simulateContract({
        address: p.target,
        abi: p.abi,
        functionName: p.functionName,
        args: p.args,
        account,
      });
      const prepared = await this.prepareAsPlatform({ account, to: p.target, data: calldata });
      return this.sendAsPlatform(account.address, prepared);
    }

    const data = appendRelayTarget(calldata, p.target);
    let gas: bigint;
    try {
      gas = await this.d.publicClient.estimateGas({ account, to: controller, data });
    } catch (err) {
      // Only a REVERT is re-dressed with the decoded reason; a transport failure is rethrown
      // untouched so an RPC outage never reads as "reverted in simulation" (see relay.ts).
      throw relayRevertError(err, { ...p, controller });
    }
    const prepared = await this.prepareAsPlatform({ account, to: controller, data, gas });
    return this.sendAsPlatform(account.address, prepared);
  }

  /**
   * Send native value (on Arc the gas token IS USDC) as the platform — the live runner's gas seeds.
   *
   * Here rather than at the call site so it shares the one chokepoint: a seed and a treasury top-up
   * come from the same key, so they compete for the same nonces.
   */
  async sendNativeAsPlatform(to: Address, value: bigint): Promise<Hex> {
    const account = this.d.managerWallet.account;
    if (!account)
      throw new Error(
        "ArcAdapter: manager wallet has no account (hoist an account on the WalletClient) — refusing to send as the zero address",
      );
    const prepared = await this.prepareAsPlatform({ account, to, value });
    return this.sendAsPlatform(account.address, prepared);
  }

  /**
   * {sendManagerCall} + await the receipt — the tail four of the five relayed sites repeat.
   *
   * Goes through the same `confirmed()` as `confirmFundTreasury` (R1). A rule that told the truth about
   * one receipt and not about the other four would be the next review finding: a bind, a metadata
   * write and a policy execute all have a post-broadcast window, and a caller that is told
   * "nothing was sent" about a mined bind resumes into a state it cannot explain.
   */
  private async sendManagerCallConfirmed(p: {
    target: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    agentManager?: Address;
  }): Promise<Hex> {
    return this.confirmed(await this.sendManagerCall(p), p.functionName);
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
    // R1, the same window one step earlier and with higher stakes: the agent NFT may already be
    // minted. A receipt-read failure here is `BroadcastUnconfirmedError` rather than a bare 429,
    // so nothing above it can say "nothing was sent" about a mint that is on chain — and the
    // resume path this function's own comment describes stays the honest instruction.
    let receipt: Awaited<ReturnType<typeof this.d.publicClient.waitForTransactionReceipt>>;
    try {
      receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (e) {
      throw new BroadcastUnconfirmedError(txHash, "createEntity", { cause: e });
    }

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

  // ── Operating-agreement amendments (design §7, the anchor sub-saga) ─────────────────────────
  //
  // The treasury pair above is the template with ONE deliberate difference: these two BROADCAST
  // and return, instead of broadcasting and awaiting. The anchor loop has to persist the tx hash
  // on the `oa_anchors` row BEFORE the receipt arrives, because a crash in that gap must resume
  // by ADOPTING the persisted tx — and re-broadcasting a schedule is not harmless here the way a
  // second policy schedule is: `scheduleOperatingAgreementUpdate` has no `AlreadyScheduled` guard,
  // so a re-schedule silently RESETS the timelock and hands the guardian a shorter veto window
  // than the one they were notified about.
  //
  // `waitForManagerReceipt` is the other half, exposed so the caller can do
  // broadcast -> persist -> confirm without reaching for the public client itself.

  /**
   * Schedule a new operating-agreement hash on the entity's LegalManager (manager-gated,
   * timelocked, guardian-vetoable). BROADCAST ONLY — see the note above.
   *
   * `agentManager` is the proxy's IMMUTABLE manager as persisted at creation: a legacy agent's
   * LegalManager still obeys the old EOA, so relaying its amendment would revert `NotManager`.
   */
  async scheduleOperatingAgreementUpdate(
    proxy: Address,
    newHash: Hex,
    agentManager?: Address,
  ): Promise<Hex> {
    return this.sendManagerCall({
      target: proxy,
      abi: legalManagerAbi as Abi,
      functionName: "scheduleOperatingAgreementUpdate",
      args: [newHash],
      agentManager,
    });
  }

  /** Execute a previously-scheduled amendment once its timelock has elapsed. BROADCAST ONLY. */
  async executeOperatingAgreementUpdate(
    proxy: Address,
    newHash: Hex,
    agentManager?: Address,
  ): Promise<Hex> {
    return this.sendManagerCall({
      target: proxy,
      abi: legalManagerAbi as Abi,
      functionName: "executeOperatingAgreementUpdate",
      args: [newHash],
      agentManager,
    });
  }

  /**
   * Await a manager-call receipt. The confirm half of the broadcast/persist/confirm split.
   *
   * BOUNDED (review F7). viem's default is to wait indefinitely, and this is called from an
   * unattended sweeper tick that holds the entity's keyed lock while it waits: one dropped
   * transaction would pin a worker, and the tick, forever. A timeout is not a failure here — it is
   * the DESIGNED path. The tx hash is already persisted on the `oa_anchors` row, so the next pass
   * adopts the broadcast rather than sending a second one, and the park's doubling backoff is what
   * keeps asking. Arc's finality is sub-second; 30s is a wide margin for a mempool, not a guess at
   * one.
   */
  async waitForManagerReceipt(txHash: Hex): Promise<{ status: "success" | "reverted" }> {
    const receipt = await this.d.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: MANAGER_RECEIPT_TIMEOUT_MS,
    });
    return { status: receipt.status };
  }

  /**
   * Earliest time this hash may be executed, or 0.
   *
   * ZERO IS AMBIGUOUS, and every caller must treat it so: `executeOperatingAgreementUpdate`
   * DELETES the entry, so 0 means "never scheduled" OR "already executed". `oaCurrentHash` is what
   * disambiguates them, and the anchor loop reads it first (design §7, audit C1).
   */
  oaScheduledAt(proxy: Address, newHash: Hex): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "scheduledAt",
      args: [newHash],
    }) as Promise<bigint>;
  }

  /** Guardian hard-veto state for one hash. Permanent until `liftVeto` — never a speed bump. */
  oaVetoed(proxy: Address, newHash: Hex): Promise<boolean> {
    return this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "vetoed",
      args: [newHash],
    }) as Promise<boolean>;
  }

  /** The entity's timelock, read PER AGENT: it is set at initialize and immutable, and the factory
   *  reuses the same value as the treasury's policy delay by construction. */
  oaAmendmentDelay(proxy: Address): Promise<bigint> {
    return this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "amendmentDelay",
    }) as Promise<bigint>;
  }

  /** The anchor the chain currently holds — `meta().operatingAgreementHash`. */
  async oaCurrentHash(proxy: Address): Promise<Hex> {
    const meta = (await this.d.publicClient.readContract({
      address: proxy,
      abi: legalManagerAbi,
      functionName: "meta",
    })) as readonly [string, bigint, Hex, bigint];
    return meta[2];
  }

  /**
   * EVERYTHING THE TOP-UP NEEDS BEFORE IT CAN BE NUMBERED — the pre-flight, the gas, the fees, the
   * chain id. No signature, no nonce, nothing recorded, and NO LOCK.
   *
   * It is a separate call from {signFundTreasury} for one reason: the saga holds the send lock
   * across sign → persist → send, and every RPC inside that window is one every other platform
   * send waits behind. All of this is slow and none of it is nonce-critical, so it happens first.
   *
   * ⚠ WHO PAYS. The account is `managerWallet`'s, in controller mode too: a treasury top-up is a
   * plain ERC-20 `transfer` from the platform wallet, NOT a role-gated manager call, so it never
   * goes through `sendManagerCall`'s relay. In controller mode that wallet is the executor — the
   * account that actually holds and spends the USDC — which is precisely the one that must sign.
   *
   * ⚠ EXPLICIT GAS, still. `USDC_TRANSFER_GAS` is passed so `prepareTransactionRequest` does not
   * estimate: on Arc the gas token IS USDC, and an estimate against a nearly-full balance reserves
   * the whole of it and fails the transfer (the 2026-07 footgun, fixed once and kept fixed here).
   *
   * `simulateContract` runs first and its revert is raised BEFORE anything is signed or recorded —
   * an empty platform wallet (2026-09-14) fails HERE, which is what keeps "nothing was sent" true
   * for the one case where it is true.
   *
   * The result carries the transfer it was asked for as well as the prepared transaction, so a
   * caller that records the amount reads it back from the same object it signs.
   */
  async prepareFundTreasury(p: {
    usdc: Address;
    treasury: Address;
    amount: bigint;
  }): Promise<PreparedFundTransfer> {
    const account = this.d.managerWallet.account;
    if (!account)
      throw new Error(
        "ArcAdapter: manager wallet has no account (hoist an account on the WalletClient) — refusing to sign as the zero address",
      );
    await this.d.publicClient.simulateContract({
      address: p.usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [p.treasury, p.amount],
      account,
    });
    const request = await this.prepareAsPlatform({
      account,
      to: p.usdc,
      data: encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [p.treasury, p.amount],
      }),
      gas: USDC_TRANSFER_GAS,
    });
    return { ...p, request };
  }

  /**
   * SIGN the prepared treasury top-up locally. Nothing is sent, and the hash is ours before
   * anything is. One RPC: the nonce.
   *
   * The last window (gate N4): persisting after the SEND still lost a transfer whose
   * `eth_sendRawTransaction` response never came back — the node had accepted it, we had no hash,
   * and the public sentence said nothing was sent. The fix is the sequence this repository already
   * proved for AgentBook registrations (`api/routes/agentBook.ts`, "SIGN → PERSIST → BROADCAST",
   * whose comment says exactly why: "the raw tx is persisted, so the reconciler re-broadcasts it").
   *
   * Three things come back and all three are persisted before the send:
   *  - `rawTx` — the signed bytes, so a re-broadcast is the SAME transaction rather than a second
   *    one at a new nonce;
   *  - `txHash` — `keccak256(rawTx)`, which is what the chain will call it;
   *  - `nonce` — the only way to tell "still pending" from "dropped" later.
   *
   * ⚠ THE CALLER HOLDS THE SENDER LOCK. This is the one platform send whose nonce-critical window
   * is not a single call — it is sign → persist → send, and the persist is what makes the signature
   * recoverable, so the lock has to span all three (`workflow/onboarding.ts` step 7). The nonce
   * picker refuses outside it rather than trusting a convention. It takes a PREPARED transfer so
   * that everything else the signature needs was fetched before that lock was taken.
   */
  async signFundTreasury(
    prepared: PreparedFundTransfer,
  ): Promise<{ rawTx: Hex; txHash: Hex; nonce: number }> {
    const account = this.d.managerWallet.account;
    if (!account)
      throw new Error(
        "ArcAdapter: manager wallet has no account (hoist an account on the WalletClient) — refusing to sign as the zero address",
      );
    // EXPLICIT, from the same ledger every other platform send draws on. Left to viem this is a
    // fresh `eth_getTransactionCount(pending)` — which is exactly the read that answers the same
    // number twice when the node has not caught up, or when two funds are in flight at once.
    const nonce = await nextSenderNonce(account.address, () => this.pendingNonce(account.address));
    // The nonce is the whole reason this is visible before anything is broadcast: it is recorded,
    // so "pending" and "dropped" can be told apart later. A hole where the number should be would
    // make that unanswerable, and quietly — a node that answers the count with anything but an
    // integer gets us a `NaN`, which persists as nothing at all. Better to fail here (the
    // registrar's rule, verbatim).
    if (!Number.isInteger(nonce))
      throw new Error(`signFundTreasury: no usable nonce for this transfer (got ${nonce})`);
    const request = { ...prepared.request, nonce };
    // Signed by the ACCOUNT, not through the wallet action, which would ask the node for the chain
    // id first — one more call inside the caller's lock, for a value the request already carries.
    // See `localSend.ts`, which does the same for every other send from a local key.
    const rawTx = await localSigner(
      this.d.managerWallet,
      "ArcAdapter: the platform account",
    )(request);
    return { rawTx, txHash: keccak256(rawTx), nonce: Number(request.nonce) };
  }

  /**
   * Put signed bytes on the wire. Idempotent by construction: re-sending the same transaction is
   * at worst a no-op the node already knows about, which is what makes a re-broadcast safe.
   *
   * Takes NO lock of its own, deliberately: on the saga's path the caller holds it (the window
   * started at the signature), and the reconciler's re-broadcast picks no nonce at all — the bytes
   * already carry theirs. A lock here would deadlock the first and buy the second nothing.
   */
  async sendRawFundTreasury(rawTx: Hex): Promise<Hex> {
    // The bounded client (`clients.ts`): on the saga's path this call happens inside the lock.
    const hash = await this.sendVia.sendRawTransaction({ serializedTransaction: rawTx });
    // The node took it, so its nonce is spent: raise the floor for the next send from this key.
    // Read from the BYTES, which cannot disagree with what was sent, and never at the cost of the
    // send — past this line nothing may turn an accepted transfer into an error (gate N4).
    try {
      const sender = this.platformAddress;
      const nonce = parseTransaction(rawTx).nonce;
      if (sender && nonce !== undefined) noteSenderBroadcast(sender, nonce);
    } catch {
      // Unparseable bytes say nothing about a transaction the node has already accepted. The floor
      // stays where it is; the next send falls back to the node's own count.
    }
    return hash;
  }

  /**
   * The platform account's MINED transaction count at `latest`.
   *
   * Never the pending count — that one includes our own unmined transaction, so it could never
   * tell us the chain had moved past it. A count HIGHER than a submission's nonce means the chain
   * advanced without that transaction, which (after a second receipt read) is what makes it
   * `dropped` rather than merely slow. Same rule, same reason, as `submitterNonce()` in the
   * AgentBook registrar.
   */
  async platformNonce(): Promise<number> {
    const account = this.d.managerWallet.account;
    if (!account) throw new Error("ArcAdapter: manager wallet has no account");
    return this.d.publicClient.getTransactionCount({
      address: account.address,
      blockTag: "latest",
    });
  }

  /**
   * BROADCAST the treasury top-up and return its hash. Does NOT wait for the receipt.
   *
   * The split exists for one reason (verification gate N2): the hash has to reach the database
   * BEFORE anything waits on it. It used to be written only in the saga's catch, so a deploy, an
   * OOM kill or a `systemctl restart` anywhere inside the receipt wait — viem's default is 180
   * seconds — lost the hash entirely, and the next attempt broadcast a second transfer.
   *
   * This mirrors the `broadcastCreateEntity` / `confirmCreateEntity` pair a few methods up, which
   * exists for exactly the same reason and whose comment says so: "re-reading the same mined tx
   * yields the same agentId, which is what the saga relies on to adopt an in-flight mint on resume
   * rather than broadcasting a second one." Money deserves at least the guarantee a mint gets.
   *
   * Everything here is PRE-broadcast: a simulate revert (the 2026-09-14 empty-wallet shape) throws
   * before any hash exists, and "nothing was sent" is true of every failure this method raises.
   */
  async broadcastFundTreasury(p: {
    usdc: Address;
    treasury: Address;
    amount: bigint;
  }): Promise<Hex> {
    const account = this.d.managerWallet.account!;
    await this.d.publicClient.simulateContract({
      address: p.usdc,
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [p.treasury, p.amount],
      account,
    });
    // Explicit gas (see USDC_TRANSFER_GAS): the manager wallet is well-funded today, but this keeps
    // the near-full-balance estimateGas footgun from biting if it ever runs low.
    const prepared = await this.prepareAsPlatform({
      account,
      to: p.usdc,
      data: encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [p.treasury, p.amount],
      }),
      gas: USDC_TRANSFER_GAS,
    });
    return this.sendAsPlatform(account.address, prepared);
  }

  /**
   * CONFIRM a broadcast treasury top-up. Everything it raises happens after the money left.
   *
   * `waitForTransactionReceipt` rejects a poll failure verbatim, so the identical
   * `HttpRequestError{status:429}` that means "the send was refused" also arrives here, where it
   * means the opposite. This is the only layer that can tell the two apart — it holds the hash —
   * so it is the layer that says so, and `publicErrorMessage` keys off the TYPE rather than trying
   * to recover a fact that was never in the text.
   */
  async confirmFundTreasury(txHash: Hex): Promise<Hex> {
    return this.confirmed(txHash, "fundTreasury");
  }

  /* There is deliberately NO broadcast-and-confirm convenience here any more.
   *
   * One existed for "callers with nothing to persist between the two", and the last such caller was
   * the CLI's fund door — which did have something to persist and simply was not doing it: no
   * `submitted` row, so a crash inside the receipt wait lost the hash of a transfer that had already
   * happened (the gap #140 closed for the API path). It now funds through the same saga
   * (`cli/index.ts`), and a caller that wants both halves writes the hash down between them. */

  /**
   * Await a broadcast transaction's receipt and insist it SUCCEEDED.
   *
   * Two failures, told apart because the difference is whether a retry is safe:
   *  - the receipt could not be READ → `BroadcastUnconfirmedError` (the transaction may be mined;
   *    nobody may re-send, and the saga reconciles it by hash later);
   *  - the receipt says `reverted` → a plain failure naming the hash. The transaction is settled
   *    and it moved nothing, so a retry is fine.
   *
   * The revert check is new with R1 and closes a gap nobody had named: `waitForTransactionReceipt`
   * RESOLVES for a reverted transaction, so `fundTreasury` used to return a hash for a transfer
   * that moved nothing and step 7 marked the entity `funded`. The reconcile path treats `reverted`
   * as "send again", and the send path must not be blind to the same fact.
   */
  private async confirmed(txHash: Hex, operation: string): Promise<Hex> {
    let receipt: { status?: string };
    try {
      receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (e) {
      throw new BroadcastUnconfirmedError(txHash, operation, { cause: e });
    }
    if (receipt.status === "reverted")
      throw new Error(`${operation}: transaction ${txHash} reverted on chain`);
    return txHash;
  }

  /**
   * What became of a transaction we already broadcast — asked ONCE, never waited on.
   *
   * `getTransactionReceipt` rather than `waitForTransactionReceipt` on purpose: a saga resuming an
   * old attempt must not block for viem's 180-second default on a transaction that may have been
   * dropped weeks ago.
   *
   * ⚠ `absent` MEANS ONE THING: the chain definitively has no receipt for this hash. It does NOT
   * mean "we could not ask".
   *
   * This distinction is a Critical finding (gate N8), and it was introduced the moment `absent`
   * stopped merely meaning "wait" and started being able to lead — with an advanced nonce — to
   * `dropped`, which authorises a NEW transfer. A `catch` that swallowed everything then read an
   * Arc RPC 429 on `eth_getTransactionReceipt` (the documented, recurring prod condition this whole
   * branch exists for) as "the transaction is gone", and sent the money a second time.
   *
   * So: `TransactionReceiptNotFoundError` and nothing else, matched BY TYPE rather than by its
   * prose — several other viem errors ("Block at number … could not be found", any wrapper
   * carrying that text) also read as "not found" and mean the read BROKE. `walk` because a
   * transport or a caller's client may have wrapped it. Everything else RETHROWS, and the caller
   * refuses rather than guessing.
   *
   * Byte-for-byte the rule `agentBookRegistrar.receiptStatus` already applies, for the same reason
   * its comment gives: parking a broken read in the pending branch waits forever on a receipt
   * nobody is fetching — and, here, spends money on one.
   */
  async receiptOutcome(txHash: Hex): Promise<"success" | "reverted" | "absent"> {
    try {
      const receipt = await this.d.publicClient.getTransactionReceipt({ hash: txHash });
      return receipt.status === "success" ? "success" : "reverted";
    } catch (e) {
      if (e instanceof BaseError && e.walk((x) => x instanceof TransactionReceiptNotFoundError))
        return "absent";
      throw e;
    }
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
