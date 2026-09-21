/**
 * ONE SEND AT A TIME PER SIGNING KEY, and one nonce each.
 *
 * Every transaction a key sends carries a nonce, and a nonce is a claim only one transaction can
 * hold. Two requests served in the same moment (two guardians funding, a fund racing a deploy)
 * used to read the node's count independently, get the same answer, and sign the same nonce: one
 * transaction won and the other was rejected or replaced. The fund path records its loser and
 * recovers it (`workflow/fundSubmissions.ts`), but recovery is a wait the user can feel, and the
 * other send paths had no recovery at all.
 *
 * So: selection, signing and broadcast happen inside a lock, and the lock is keyed by the SIGNER
 * ADDRESS — not by "the platform", not by the entity. The address is what the nonce belongs to.
 * Two keys are two nonce spaces and must not block each other; one key reached through two
 * different configuration names is ONE nonce space and shares its lock without anyone arranging
 * it.
 *
 * ⚠ THE LOCK NEVER COVERS A RECEIPT WAIT. It covers the window from picking the nonce to the node
 * accepting the bytes, and nothing else. `withKeyedLock` is a FIFO promise chain, so a section that
 * waits for a receipt inside it would stop every other send from this key for as long as the chain
 * takes — and a dropped transaction would stop them forever.
 *
 * ⚠ NOT REENTRANT, for the same reason: taking the lock inside a section that already holds it for
 * the same address waits on an entry that is still running, forever. Hence the shape below —
 * {sendFromSender} locks the leaf send, {nextSenderNonce} refuses to pick a nonce unless its
 * caller already holds the lock, and nothing in between takes it a second time.
 *
 * Single process, by deployment: one API process sends with the platform key (the monitor only
 * reads, the CLI is run by hand). A multi-process deployment would need the counter to live
 * somewhere both processes can see.
 */
import { withKeyedLock } from "../../payments/keyedMutex";
import type { Address, Hex } from "../../types";

/** The lock key. Lowercased: the same key spelled two ways is still one nonce space. */
function keyFor(sender: Address): string {
  return `sender:${sender.toLowerCase()}`;
}

/** Which senders are inside their locked section right now (at most one holder per key). */
const held = new Set<string>();

/**
 * The lowest nonce this process may still use, per sender — `lastBroadcastNonce + 1`.
 *
 * It exists because the node's answer can be BEHIND us: a load-balanced RPC may serve a nonce read
 * from a replica that has not seen the transaction we broadcast a moment ago, and that answer,
 * believed, signs the same nonce twice.
 *
 * It is a FLOOR, never the number itself — `max(node, floor)` — so a node that is AHEAD (another
 * signer of the same key, a restart, our own transaction mining) still wins.
 */
const floors = new Map<string, number>();

/**
 * Run `fn` with this sender's send lock held. For the nonce-critical window ONLY: pick, sign,
 * broadcast. Callers that also have something to persist between signing and broadcasting keep
 * that persist inside (a synchronous SQLite write, no slower than the signature it records); a
 * receipt wait goes after the section, never inside it.
 */
export function withSenderLock<T>(sender: Address, fn: () => Promise<T>): Promise<T> {
  const key = keyFor(sender);
  return withKeyedLock(key, async () => {
    held.add(key);
    try {
      return await fn();
    } finally {
      // Releases on the failure path too: a section that threw must not strand every later send
      // from this key behind a lock nobody will give back.
      held.delete(key);
    }
  });
}

/** Is this sender's lock held by the section we are in? The guard the nonce picker enforces. */
export function senderLockHeld(sender: Address): boolean {
  return held.has(keyFor(sender));
}

/**
 * The nonce the next transaction from `sender` must carry: the node's PENDING count, raised to our
 * floor.
 *
 * `pending` (not `latest`) because the question is "what would a new transaction use" — a count
 * that excluded our own unmined transactions would hand the next send a nonce that is already
 * claimed.
 *
 * REFUSES outside the lock. Selection is the whole race: a nonce picked unlocked is a nonce two
 * callers can hold, which is the defect, and a helper that quietly allowed it would be the way the
 * defect came back.
 */
export async function nextSenderNonce(
  sender: Address,
  pendingNonce: () => Promise<number>,
): Promise<number> {
  if (!senderLockHeld(sender))
    throw new Error(
      "nextSenderNonce: the sender lock is not held — pick the nonce inside withSenderLock/sendFromSender",
    );
  const floor = floors.get(keyFor(sender)) ?? 0;
  return Math.max(await pendingNonce(), floor);
}

/**
 * Record a broadcast the node ACCEPTED, so the next send from this sender does not reuse its
 * nonce even if the node's count has not caught up.
 *
 * ⚠ ONLY after a broadcast that succeeded. After one that threw, the bytes may never exist for the
 * chain, and skipping their nonce would leave a hole: every later transaction from this key would
 * queue behind a nonce nothing will ever fill. Reusing it is the recoverable direction — at worst
 * the node already had the first transaction and rejects the second as a duplicate.
 *
 * `max`, so a re-broadcast of older bytes (the fund reconciler's rule 5) can never lower the floor.
 */
export function noteSenderBroadcast(sender: Address, nonce: number): void {
  const key = keyFor(sender);
  floors.set(key, Math.max(floors.get(key) ?? 0, nonce + 1));
}

/**
 * THE CHOKEPOINT for a send that signs and broadcasts in one call (viem's `writeContract` /
 * `sendTransaction`: they return at broadcast, so the whole nonce-critical window is the call).
 *
 * Pick inside the lock, broadcast inside the lock, record only what the node took. `broadcast`
 * receives the nonce and MUST pass it on explicitly, so viem does not read one of its own.
 */
export function sendFromSender(
  sender: Address,
  pendingNonce: () => Promise<number>,
  broadcast: (nonce: number) => Promise<Hex>,
): Promise<Hex> {
  return withSenderLock(sender, async () => {
    const nonce = await nextSenderNonce(sender, pendingNonce);
    const hash = await broadcast(nonce);
    noteSenderBroadcast(sender, nonce);
    return hash;
  });
}

/**
 * Forget every floor. A TEST SEAM: the floors are process-wide (one key, one counter, whichever
 * client sends), so tests that share a module registry would otherwise inherit each other's.
 */
export function resetSenderNonces(): void {
  floors.clear();
}
