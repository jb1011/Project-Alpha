import { randomUUID } from "node:crypto";
import { encodeFunctionData } from "viem";
import type { SubmitAndConfirmOptions } from "../adapters/circle/circleExec";
import { submitAndConfirm } from "../adapters/circle/circleExec";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import type {
  BridgeLegName,
  BridgeLegRecord,
  SqliteBridgeLegRepository,
} from "../persistence/bridgeLegRepository";
import type { Address, Hex } from "../types";
import type { StandingExposure } from "./standingExposure";

/**
 * Tier-0 circle-path funding bridge (spec 2026-08-03 — "The new funding flow", audit item 3).
 *
 * Three legs, all sent BY THE OPERATOR SCA through Circle contractExecution (the pocket EOA never
 * transacts — depositFor credits its Gateway balance directly):
 *
 *   1. fund_operator : treasury.fundOperator(amount)            — governed pull, onlyOperator
 *   2. approve       : usdc.approve(gatewayWallet, amount)      — EXACT amount per bridge (the
 *                      spec's default approve policy; a standing infinite approve from the
 *                      float-holding SCA is explicitly rejected)
 *   3. deposit_for   : gatewayWallet.depositFor(usdc, pocket, amount)
 *
 * No gas seeding (Gas Station sponsors the SCA), no pocket-EOA hop, no balance heuristics:
 * resume comes ONLY from the persisted bridge_legs saga + Circle's idempotent replay
 * (deterministic key per bridgeKey:leg:attempt). Ceiling/available checks mirror topUpPocket's
 * and run once, at bridge creation — a resumed bridge already passed them and re-checking would
 * wedge a half-executed bridge whose own first leg moved the numbers.
 */
export interface CircleBridgeDeps {
  api: Pick<CircleWalletsApi, "createContractExecutionTransaction" | "getTransaction">;
  legs: SqliteBridgeLegRepository;
  entityKey: string;
  operatorWalletId: string;
  treasury: Address;
  usdc: Address;
  gatewayWallet: Address;
  pocketAddress: Address;
  available: () => Promise<bigint>; // treasury.available() — the cap layer
  standingExposure: () => Promise<StandingExposure>;
  ceiling: bigint; // MAX_POCKET_FLOAT_USDC, atomic
  /** S5: Gas Station sponsorship observed from confirmed-tx fees (recorded, never checked). */
  outflows?: { record(path: "gas_sponsorship", amountAtomic: bigint, ref: string | null): void };
  confirm?: SubmitAndConfirmOptions;
  /** Bridge-key minting, injectable for tests. Default: a random UUID per NEW bridge. */
  newBridgeKey?: () => string;
}

const treasuryFundOperatorAbi = [
  {
    type: "function",
    name: "fundOperator",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const gatewayDepositForAbi = [
  {
    type: "function",
    name: "depositFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function legCall(
  d: CircleBridgeDeps,
  leg: BridgeLegName,
  amount: bigint,
): { contractAddress: Address; callData: Hex } {
  switch (leg) {
    case "fund_operator":
      return {
        contractAddress: d.treasury,
        callData: encodeFunctionData({
          abi: treasuryFundOperatorAbi,
          functionName: "fundOperator",
          args: [amount],
        }),
      };
    case "approve":
      return {
        contractAddress: d.usdc,
        callData: encodeFunctionData({
          abi: erc20ApproveAbi,
          functionName: "approve",
          args: [d.gatewayWallet, amount],
        }),
      };
    case "deposit_for":
      return {
        contractAddress: d.gatewayWallet,
        callData: encodeFunctionData({
          abi: gatewayDepositForAbi,
          functionName: "depositFor",
          args: [d.usdc, d.pocketAddress, amount],
        }),
      };
  }
}

/** Structured refusal when an in-flight bridge exists for a DIFFERENT amount: completing it under
 *  a mismatched request would make the returned hashes lie about what was funded. The caller
 *  retries with the in-flight amount to complete it, then funds the new amount separately. */
export class BridgeInFlightError extends Error {
  constructor(
    readonly entityKey: string,
    readonly inFlightAmount: bigint,
    readonly requestedAmount: bigint,
  ) {
    super(
      JSON.stringify({
        error: "bridge-in-flight",
        entityKey,
        inFlightAmount: inFlightAmount.toString(),
        requestedAmount: requestedAmount.toString(),
        hint: `retry fund_pocket with amount=${inFlightAmount.toString()} to complete the in-flight bridge first`,
      }),
    );
    this.name = "BridgeInFlightError";
  }
}

/** Run (or resume) the circle funding bridge for one entity. Returns the on-chain tx hashes in
 *  saga order — REAL hashes, because every leg is polled to confirmation (the spec's fund_pocket
 *  tool-contract decision: block until confirmed rather than return raw Circle tx-ids). Callers
 *  must hold the per-entity keyed lock. */
export async function runCircleBridge(d: CircleBridgeDeps, amount: bigint): Promise<Hex[]> {
  if (amount <= 0n) throw new Error("top-up amount must be positive");

  let legs: BridgeLegRecord[];
  const open = d.legs.findIncomplete(d.entityKey);
  if (open) {
    const inFlight = open[0]!.amount;
    if (inFlight !== amount) throw new BridgeInFlightError(d.entityKey, inFlight, amount);
    legs = open; // crash-retry of the same funding call — resume, never re-check or re-pull
  } else {
    // New bridge: the cap + ceiling gates run exactly once, before anything moves.
    const available = await d.available();
    if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
    const standing = await d.standingExposure();
    if (standing.total + amount > d.ceiling) {
      throw new Error(
        JSON.stringify({
          error: "float-ceiling-exceeded",
          standing: standing.total.toString(),
          breakdown: {
            operatorEoa: standing.operatorEoa.toString(),
            pocketEoa: standing.pocketEoa.toString(),
            gateway: standing.gateway.toString(),
          },
          requested: amount.toString(),
          ceiling: d.ceiling.toString(),
        }),
      );
    }
    const bridgeKey = `${d.entityKey}:${(d.newBridgeKey ?? randomUUID)()}`;
    d.legs.createBridge(bridgeKey, d.entityKey, amount);
    legs = d.legs.legsOf(bridgeKey);
  }

  const hashes: Hex[] = [];
  for (const leg of legs) {
    if (leg.state === "confirmed" && leg.txHash) {
      hashes.push(leg.txHash);
      continue;
    }
    // A FAILED Circle tx burned its idempotency key — bump the attempt for a fresh key. A
    // 'submitted' leg keeps its attempt: the deterministic key makes re-submit replay the
    // original tx, which we then poll to conclusion.
    let attempt = leg.attempt;
    if (leg.state === "failed") attempt = d.legs.bumpAttempt(leg.bridgeKey, leg.leg);

    const { contractAddress, callData } = legCall(d, leg.leg, leg.amount);
    try {
      const { circleTxId, txHash } = await submitAndConfirm(
        d.api,
        {
          walletId: d.operatorWalletId,
          contractAddress,
          callData,
          idempotencySeed: `${leg.bridgeKey}:${leg.leg}:${attempt}`,
          refId: `${d.entityKey}:${leg.leg}`,
        },
        {
          ...d.confirm,
          onNetworkFee: (fee, txId) => d.outflows?.record("gas_sponsorship", fee, txId),
        },
      );
      // markSubmitted before markConfirmed would need a poll-phase callback; the deterministic
      // idempotency key already makes the submit crash-safe, so record the terminal state only —
      // plus the circle tx-id for forensics either way.
      d.legs.markSubmitted(leg.bridgeKey, leg.leg, circleTxId);
      d.legs.markConfirmed(leg.bridgeKey, leg.leg, txHash);
      hashes.push(txHash);
    } catch (e) {
      if (e instanceof Error && e.name === "CircleTxFailedError") {
        d.legs.markFailed(leg.bridgeKey, leg.leg, e.message);
      } else if (e instanceof Error && e.name === "CircleTxTimeoutError") {
        const txId = (e as { circleTxId?: string }).circleTxId;
        if (txId) d.legs.markSubmitted(leg.bridgeKey, leg.leg, txId);
      }
      throw e;
    }
  }
  return hashes;
}
