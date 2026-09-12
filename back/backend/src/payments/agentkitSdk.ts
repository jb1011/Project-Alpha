/**
 * One lazy handle on `@worldcoin/agentkit` for the whole backend.
 *
 * WHY LAZY: the SDK's import cost is paid on the FIRST World-layer request, not at boot by every
 * deployment. Measured on the api import chain under tsx: 209.1 -> 201.2 MB RSS (~8 MB marginal —
 * much of the SDK's dep tree is shared with viem; the audit's ~29.5 MB was the full-boot estimate).
 *
 * WHY SHARED: the seller (worldVerifier) mints challenges with it and the buyer signs them with
 * it, and both used to keep their own four-line copy of this. Node's module cache made the
 * duplication harmless but not obvious; one exported loader makes "the SDK loads once" a fact of
 * the code rather than of the runtime.
 */
let agentkitMod: Promise<typeof import("@worldcoin/agentkit")> | undefined;

export function loadAgentkitSdk(): Promise<typeof import("@worldcoin/agentkit")> {
  agentkitMod ??= import("@worldcoin/agentkit");
  return agentkitMod;
}
