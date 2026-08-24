import type { Hex } from "viem";

/** Hashes come off logs, off the API and out of the contract; only their VALUE is comparable. */
export function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Which amendment hashes the guardian's card must ask the CONTRACT about.
 *
 * Two sources, and they answer different questions. The `AmendmentScheduled` log scan DISCOVERS
 * hashes — including the ones the platform is not talking about, which is the whole reason the
 * card reads the chain instead of the backend. The API's `pendingHash` is a hash we already know
 * the identity of; what we do not know is whether it is actually scheduled.
 *
 * So the API's hash is ALWAYS in the list, whether or not a log turned it up. Deriving the reads
 * from the logs alone made the card's most consequential sentence — "the schedule transaction has
 * not confirmed yet, nothing to veto" — conditional on the log query having succeeded over the
 * full history. On an RPC that caps log ranges (the case the card already handles by falling back
 * to a bounded window), a genuinely live amendment older than that window produced exactly that
 * reassurance. `scheduledAt(hash)` is a point read against a mapping: it costs one call, needs no
 * range at all, and is the authority the contract itself checks.
 */
export function collectAmendmentHashes(
  fromLogs: readonly Hex[],
  apiPendingHash: string | null,
): Hex[] {
  const out: Hex[] = [];
  const seen = new Set<string>();
  const push = (hash: Hex) => {
    const key = hash.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(hash);
  };
  for (const hash of fromLogs) push(hash);
  if (apiPendingHash) push(apiPendingHash as Hex);
  return out;
}
