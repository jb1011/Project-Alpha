import { type Abi, BaseError, decodeErrorResult, isAddress, isHex, size } from "viem";
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

/** Bytes of address suffix the controller strips off the end of `msg.data`. */
export const RELAY_TARGET_BYTES = 20;

/** Controller floor: 4-byte selector + 20-byte target. Anything shorter reverts `MsgDataInvalid`. */
export const RELAY_MIN_BYTES = 4 + RELAY_TARGET_BYTES;

/**
 * `D ++ T`. Deliberately strict about its inputs: a malformed prefix or target would produce a
 * transaction that relays to a *different* contract than intended, which is exactly the class of
 * mistake the encoding is otherwise silent about.
 */
export function appendRelayTarget(data: Hex, target: Address): Hex {
  if (!isHex(data)) throw new Error(`relay: calldata must be a 0x hex string, got ${String(data)}`);
  if (data.length % 2 !== 0)
    throw new Error("relay: calldata must be whole bytes (even hex length)");
  if (size(data) < 4)
    throw new Error(`relay: calldata must carry at least a 4-byte selector (got ${size(data)})`);
  if (!isAddress(target, { strict: false }))
    throw new Error(`relay: target must be a 0x address, got ${String(target)}`);
  return `${data}${target.slice(2).toLowerCase()}` as Hex;
}

/** The relay endpoint for this deployment: the controller when configured, else undefined
 *  (legacy direct-call mode — the signing key IS the manager and calls targets directly). */
export function relayAddress(cfg: { controllerAddress?: Address }): Address | undefined {
  return cfg.controllerAddress;
}

/**
 * Decorate a failed relay simulation so the operator sees WHAT reverted, not a raw hex blob.
 *
 * The controller bubbles the target's revert verbatim, but `eth_call` against the controller has no
 * ABI attached, so viem cannot name a custom error the way `simulateContract` does. We walk the
 * error chain for the revert bytes and decode them against the target's ABI — recovering
 * `CapExceeded(...)`-style names — and fall back to the original message when the data is a
 * controller-level error we don't have an ABI for (e.g. `NotAuthorized(selector, sender)`).
 */
export function relayRevertError(
  err: unknown,
  ctx: { abi: Abi; functionName: string; target: Address; controller: Address },
): Error {
  const decoded = decodeRevert(err, ctx.abi);
  const where = `relay ${ctx.functionName} -> ${ctx.target} via controller ${ctx.controller}`;
  const detail = decoded ?? (err instanceof BaseError ? err.shortMessage : (err as Error)?.message);
  return new Error(`${where} reverted in simulation: ${detail ?? "unknown reason"}`, {
    cause: err,
  });
}

/** Best-effort `Name(arg, arg)` from the revert bytes buried in a viem call error. */
function decodeRevert(err: unknown, abi: Abi): string | undefined {
  const data = revertData(err);
  if (!data) return undefined;
  try {
    const { errorName, args } = decodeErrorResult({ abi, data });
    return `${errorName}(${(args ?? []).map((a) => String(a)).join(", ")})`;
  } catch {
    return `revert data ${data}`; // not in the target's ABI (controller-level error) — show it raw
  }
}

/** viem nests the raw revert bytes under `.data` (RawContractError) somewhere in the cause chain. */
function revertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 10; depth++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && isHex(d) && size(d as Hex) >= 4) return d as Hex;
    if (typeof d === "object" && d !== null) {
      const inner = (d as { data?: unknown }).data;
      if (typeof inner === "string" && isHex(inner) && size(inner as Hex) >= 4) return inner as Hex;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
