import type { Address, Hex } from "viem";
import type { PreparedPlatformTx } from "../adapters/arc/arcAdapter";
import { assertRealHuman } from "../api/routes/worldId";
import { OutflowCeilingError } from "../payments/outflowMeter";
import {
  type LegalBodyOrderDeps,
  assertThisDeployment,
  chainCall,
  requireOwnedOrder,
  takeDoorTokens,
} from "./orders";
import { refusal } from "./sentences";

/**
 * THE GAS SEED: a small native amount the platform sends to the owner of an order's identity, once
 * per tenant, ever, so that the owner can pay for the one transaction the flow leaves to it: the
 * pointer from its identity to its legal body.
 *
 * Optional: off unless the deployment sets an amount (LEGAL_BODY_GAS_SEED_USDC, at most 0.05).
 * `requestGasSeed` decides, in this order:
 *  0. off: 409 `gas_seed_disabled`, before anything is read and without spending a token;
 *  1. a real human (never a waiver), then the tenant's bucket and the doors' budget;
 *  2. the tenant's order (the uniform 404), of this deployment, and `deployed`: the link was
 *     verified and the body exists, and only the pointer is missing (else 409 `order_closed`);
 *  3. three reads, for the recipient, the order's identity owner: its code, its balance, and the
 *     transfer's gas. Only an address a key controls directly is seeded: one with no code, or an
 *     EIP-7702 delegation (exactly 23 bytes: `0xef0100` and the delegate's address). Any other
 *     code is 409 `owner_pays_own_gas`, and a balance at or above the amount is 409 `not_needed`.
 *     The seed's gas is capped at `SEED_TRANSFER_GAS_LIMIT`: a transfer estimated above it is 409
 *     `owner_pays_own_gas` as well;
 *  4. the platform's outflow meter, asked for the amount in 6-decimal USDC. Over its ceiling: 503
 *     `busy`, with nothing recorded, so a refusal of the meter does not spend the tenant's seed;
 *  5. the transfer is prepared before the seed is recorded: its fees and chain id, with the cap as
 *     its gas limit, and no lock held. A failure here puts nothing on the wire, so it is the usual
 *     503 with nothing recorded, and the tenant can ask again;
 *  6. ONE synchronous transaction: the tenant's requests are counted across all its orders (one is
 *     enough for 409 `gas_seed_used`), and this request is recorded;
 *  7. the send, inside the platform key's send lock: the nonce, the signature and the broadcast;
 *     then `gas_seeded` with its hash, then the outflow.
 *
 * The request is recorded before the send, so a send that fails leaves the seed spent: the tenant
 * cannot ask again, and the operator sees why (a request with no `gas_seeded`, and the line that
 * names the order, the stage and the error). That is the side to fail on: the other could seed
 * twice. Its answer is 503 `gas_seed_unconfirmed`, never `chain_unavailable`, whose sentence says
 * that nothing changed. It still counts as an outflow, with no hash: the node may have taken the
 * transfer.
 *
 * Amounts: the native value is in wei (18 decimals). The meter and the recorded request count
 * millionths of a USDC, which on Arc is the native unit: the wei divided by 10^12. The request's
 * amount is recorded as a JSON number, since a value in wei does not fit a safe integer.
 */

export interface GasSeedDeps {
  orders: LegalBodyOrderDeps;
  /** The seed, in wei; 0 is off. */
  amountWei: bigint;
  /** The address's code, undefined for none: the public client's `getCode`. */
  readCode(address: Address): Promise<Hex | undefined>;
  /** The address's native balance, in wei: the public client's `getBalance`. */
  readBalance(address: Address): Promise<bigint>;
  /** The gas of a transfer of `value` wei to `to` from the address the platform sends from: the
   *  public client's `estimateGas`. */
  estimateTransferGas(to: Address, value: bigint): Promise<bigint>;
  /** The platform outflow meter's check, in 6-decimal USDC: throws `OutflowCeilingError` when the
   *  amount would take the window over its ceiling. */
  checkOutflow(valueAtomic: bigint): void;
  /** The first half of the platform's native send: the transfer of `value` wei to `to`, with `gas`
   *  as its gas limit, prepared with no lock held. Nothing is signed or sent:
   *  `ArcAdapter.prepareNativeAsPlatform`. */
  prepareTransfer(to: Address, value: bigint, gas: bigint): Promise<PreparedPlatformTx>;
  /** The second half: the prepared transfer numbered, signed and broadcast inside the platform
   *  key's send lock, answering the node's hash: `ArcAdapter.sendPreparedAsPlatform`. */
  sendPrepared(prepared: PreparedPlatformTx): Promise<Hex>;
  /** Records the outflow on the meter's `gas_seed` path, in 6-decimal USDC: with the send's hash,
   *  or with none for a send that threw, which the node may still have taken. */
  recordOutflow(valueAtomic: bigint, hash: Hex | null): void;
}

/** The seed's gas cap: the most a transfer is estimated at and still sent, and the send's gas
 *  limit. */
export const SEED_TRANSFER_GAS_LIMIT = 60_000n;

/** Wei in one millionth of a USDC: the native unit has 18 decimals, the meter counts 6. */
const WEI_PER_MICRO_USDC = 10n ** 12n;

/** The code of an EIP-7702 delegated account: this prefix, then the delegate's 20 bytes. */
const DELEGATION_PREFIX = "0xef0100";
const DELEGATION_CODE_BYTES = 23;

/** Whether an address with this code is one a key controls directly: no code, or a delegation. */
function keyControlled(code: Hex | undefined): boolean {
  if (code === undefined || code === "0x") return true;
  return (
    code.length === 2 + 2 * DELEGATION_CODE_BYTES &&
    code.toLowerCase().startsWith(DELEGATION_PREFIX)
  );
}

/** Sends the tenant's one gas seed to the identity's owner of its deployed order `id`, by the rules
 *  above. Every refusal is an `ApiError` with its code's fixed sentence. */
export async function requestGasSeed(
  d: GasSeedDeps,
  tenantId: Address,
  id: string,
): Promise<{ status: "sent"; txHash: Hex }> {
  const deps = d.orders;

  // 0.
  if (d.amountWei <= 0n) throw refusal("gas_seed_disabled", 409);

  // 1.
  assertRealHuman(deps.world, tenantId, deps.environment);
  takeDoorTokens(deps, tenantId);

  // 2.
  const row = requireOwnedOrder(deps, tenantId, id);
  assertThisDeployment(deps, row);
  if (row.bindingState !== "deployed") throw refusal("order_closed", 409);
  const orderId = row.legalBodyId;
  const to = row.identityOwner;
  // The schema holds every deployed row to an identity owner: one without was not written here.
  if (to === null) throw new Error(`legal body ${orderId} is deployed with no identity owner`);

  // 3.
  const code = await chainCall(orderId, "gas_seed_code", () => d.readCode(to));
  if (!keyControlled(code)) throw refusal("owner_pays_own_gas", 409);
  const balance = await chainCall(orderId, "gas_seed_balance", () => d.readBalance(to));
  if (balance >= d.amountWei) throw refusal("not_needed", 409);
  const gas = await chainCall(orderId, "gas_seed_estimate", () =>
    d.estimateTransferGas(to, d.amountWei),
  );
  if (gas > SEED_TRANSFER_GAS_LIMIT) throw refusal("owner_pays_own_gas", 409);

  // 4.
  const microUsdc = d.amountWei / WEI_PER_MICRO_USDC;
  try {
    d.checkOutflow(microUsdc);
  } catch (err) {
    if (err instanceof OutflowCeilingError) throw refusal("busy", 503);
    throw err;
  }

  // 5. Nothing is recorded yet, so a failure here costs the tenant nothing.
  const prepared = await chainCall(orderId, "gas_seed_prepare", () =>
    d.prepareTransfer(to, d.amountWei, SEED_TRANSFER_GAS_LIMIT),
  );

  // 6. The write lock is held from the count to the record, so a second request, for this order
  //    or another of the tenant's, counts this one.
  deps.transaction(() => {
    if (deps.repo.countEventsByTenant(tenantId, "gas_seed_requested") >= 1)
      throw refusal("gas_seed_used", 409);
    deps.repo.recordEvent(orderId, "gas_seed_requested", "tenant", null, {
      to,
      microUsdc: Number(microUsdc),
    });
  });

  // 7. `chainCall` writes the operator's line for a send that throws. The seed is recorded by now,
  //    so whatever the send did, the answer to its failure says the seed is spent; and since the
  //    node may have taken the transfer, it counts as an outflow, with no hash to name.
  const txHash = await chainCall(orderId, "gas_seed_send", () => d.sendPrepared(prepared)).catch(
    () => {
      d.recordOutflow(microUsdc, null);
      throw refusal("gas_seed_unconfirmed", 503);
    },
  );
  deps.repo.recordEvent(orderId, "gas_seeded", "system", txHash, null);
  d.recordOutflow(microUsdc, txHash);
  return { status: "sent", txHash };
}
