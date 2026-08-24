/**
 * One place to turn a wallet/RPC error into something a person can read.
 *
 * Three components had this function copied verbatim (settings, dashboard, the veto card) — and a
 * copied error formatter is the kind of thing that drifts silently: one copy grows a cap, another
 * keeps the whole stack, and the same failure reads differently depending on which card you were
 * looking at when it happened.
 *
 * Viem and wagmi errors are deliberately verbose: the first line names the failure, and everything
 * under it is the request, the ABI item and a docs link. The first line is the part a guardian can
 * act on, so that is what surfaces; the rest belongs in the console.
 */
export function shortenErr(msg: string): string {
  const first = msg.split("\n")[0]?.trim() ?? "Transaction failed.";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}
