import {
  type Abi,
  BaseError,
  RawContractError,
  concatHex,
  decodeErrorResult,
  isAddress,
  isHex,
  size,
} from "viem";
import { noviControllerAbi } from "../../abis/generated";
import type { Address, Hex } from "../../types";

/**
 * NoviController relay encoding (docs/design/2026-08-13-novi-controller-design.md §3).
 *
 * The controller is a selector-allowlisted relay (Euler v2 `GovernorAccessControl` shape): a manager
 * call to target T with calldata D is sent as a RAW transaction to the controller with
 *
 *     data = D ++ T          // T = the 20 raw address bytes, appended LAST
 *
 * The controller's fallback slices the trailing 20 bytes off as the target, checks
 * `hasRole(bytes32(selector), msg.sender)`, then `call`s the target with the remaining prefix and
 * bubbles the return data / revert VERBATIM — which is why existing error decoding keeps working.
 *
 * The signing key is unchanged: it stops being the on-chain `manager` identity and becomes the
 * EXECUTOR (tx sender) only. `msg.data.length < 24` is the controller's floor, so the minimum
 * well-formed relay is a bare 4-byte selector + the 20-byte target.
 */

/**
 * `D ++ T` (T = 20 raw address bytes). Deliberately strict about its inputs: a malformed prefix or
 * target would produce a transaction that relays to a *different* contract than intended, which is
 * exactly the class of mistake the encoding is otherwise silent about.
 */
export function appendRelayTarget(data: Hex, target: Address): Hex {
  if (!isHex(data)) throw new Error(`relay: calldata must be a 0x hex string, got ${String(data)}`);
  if (data.length % 2 !== 0)
    throw new Error("relay: calldata must be whole bytes (even hex length)");
  if (size(data) < 4)
    throw new Error(`relay: calldata must carry at least a 4-byte selector (got ${size(data)})`);
  if (!isAddress(target, { strict: false }))
    throw new Error(`relay: target must be a 0x address, got ${String(target)}`);
  // The validation above is the point of this function; `concatHex` is just the join, and using
  // viem's keeps the 0x-prefix handling out of our hands. Lowercased so the bytes we send are
  // deterministic regardless of how the caller checksummed the address.
  return concatHex([data, target.toLowerCase() as Hex]);
}

/**
 * Decorate a REVERTED relay preflight so the operator sees WHAT reverted, not a raw hex blob.
 *
 * The controller bubbles the target's revert verbatim, but the preflight (`eth_estimateGas`
 * against the controller) has no ABI attached, so viem cannot name a custom error the way
 * `simulateContract` does. We walk the error chain for the revert bytes and decode them against
 * the target's ABI CONCATENATED WITH THE CONTROLLER'S — so a `CapExceeded()` from the vault and a
 * `NotAuthorized(selector, caller)` from the relay itself both name themselves. (`decodeErrorResult`
 * also covers `Error(string)` and `Panic(uint256)`, which viem appends internally; viem's
 * `getContractError` was considered and left alone — it is built around a function call on a known
 * ABI, and the relay is deliberately a raw send whose target ABI is not the one being called.)
 *
 * IMPORTANT: when the error carries NO revert data it is NOT a revert — it is transport (RPC
 * timeout, connection reset, rate limit). Those are returned UNTOUCHED, because dressing a network
 * blip up as "reverted in simulation" sends the operator hunting a contract bug that never happened.
 */
export function relayRevertError(
  err: unknown,
  ctx: { abi: Abi; functionName: string; target: Address; controller: Address },
): Error {
  const data = revertData(err);
  // No revert bytes anywhere in the chain => not a revert. Hand the original back verbatim.
  if (!data) return err instanceof Error ? err : new Error(String(err));

  const where = `relay ${ctx.functionName} -> ${ctx.target} via controller ${ctx.controller}`;
  const detail =
    decodeRevert(data, ctx.abi) ??
    (err instanceof BaseError ? err.shortMessage : (err as Error)?.message);
  return new Error(`${where} reverted in simulation: ${detail ?? "unknown reason"}`, {
    cause: err,
  });
}

/** Best-effort `Name(arg, arg)` from revert bytes, against the target's ABI + the controller's. */
function decodeRevert(data: Hex, abi: Abi): string | undefined {
  try {
    const { errorName, args } = decodeErrorResult({
      abi: [...abi, ...(noviControllerAbi as unknown as Abi)],
      data,
    });
    return `${errorName}(${(args ?? []).map((a) => String(a)).join(", ")})`;
  } catch {
    return `revert data ${data}`; // in neither ABI (a third-party target) — show it raw
  }
}

/** viem carries the raw revert bytes in a RawContractError inside the cause chain; `walk` is
 *  viem's supported API for retrieving it (a hand-rolled traversal would silently break on a
 *  viem-internal nesting change and degrade every relay failure to an undecoded blob). */
function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const raw = err.walk((e) => e instanceof RawContractError) as RawContractError | null;
  const d = raw?.data;
  const data = typeof d === "object" && d !== null ? (d as { data?: unknown }).data : d;
  return typeof data === "string" && isHex(data) && size(data) >= 4 ? data : undefined;
}
