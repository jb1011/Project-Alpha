/**
 * The per-signer send lock and its nonce ledger.
 *
 * Every property here is one way two transactions from the same key end up claiming the same
 * nonce — which is the defect this module exists to remove. No chain, no viem: the node is a
 * counter the test moves by hand, so a STALE answer (the shape a load-balanced RPC gives) is just
 * a number that did not change.
 */
import type { Address, Hex } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import {
  SENDER_FLOOR_TTL_MS,
  nextSenderNonce,
  resetSenderNonces,
  sendFromSender,
  senderLockHeld,
  trackedSenderCount,
  withSenderLock,
} from "../../../src/adapters/arc/senderLock";

const A = "0x000000000000000000000000000000000000000A" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;

/** A node that answers `eth_getTransactionCount(pending)` — and only moves when told to. */
function fakeNode(start = 0) {
  let pending = start;
  return {
    pendingNonce: vi.fn(async () => pending),
    /** The node saw a broadcast (or, when left alone, it did not: that is the stale case). */
    advance: () => {
      pending += 1;
    },
  };
}

const hashFor = (nonce: number) => `0x${nonce.toString(16).padStart(64, "0")}` as Hex;

beforeEach(() => resetSenderNonces());

test("N concurrent sends from ONE signer get distinct consecutive nonces, broadcast in order", async () => {
  const node = fakeNode(5);
  const broadcast: number[] = [];
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map(() =>
      sendFromSender(A, node.pendingNonce, async (nonce) => {
        // A real broadcast is a round trip: yield, so an unserialised implementation interleaves.
        await new Promise((r) => setTimeout(r, 1));
        broadcast.push(nonce);
        node.advance();
        return hashFor(nonce);
      }),
    ),
  );
  expect(broadcast).toEqual([5, 6, 7, 8, 9]);
  expect(new Set(broadcast).size).toBe(5);
  expect(results).toEqual([5, 6, 7, 8, 9].map(hashFor));
});

test("two DIFFERENT signers do not block each other", async () => {
  const nodeA = fakeNode(1);
  const nodeB = fakeNode(30);
  let releaseA: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    releaseA = r;
  });

  const a = sendFromSender(A, nodeA.pendingNonce, async (nonce) => {
    await blocked;
    return hashFor(nonce);
  });
  // B finishes while A is still inside its broadcast. A shared lock would deadlock this await.
  await expect(sendFromSender(B, nodeB.pendingNonce, async (n) => hashFor(n))).resolves.toBe(
    hashFor(30),
  );
  releaseA();
  await expect(a).resolves.toBe(hashFor(1));
});

test("a send that THROWS before broadcast consumes no nonce — the next send reuses it", async () => {
  const node = fakeNode(12);
  await expect(
    sendFromSender(A, node.pendingNonce, async () => {
      throw new Error("the node refused it");
    }),
  ).rejects.toThrow("the node refused it");
  // Nothing left the process, so 12 is still ours. Skipping it would leave a gap that strands
  // every later transaction from this key behind a nonce nothing will ever fill.
  const used: number[] = [];
  await sendFromSender(A, node.pendingNonce, async (nonce) => {
    used.push(nonce);
    return hashFor(nonce);
  });
  expect(used).toEqual([12]);
});

test("a STALE pending count after a successful broadcast still yields nonce + 1", async () => {
  // The load-balanced-RPC shape: the replica that answers the second read has not seen our first
  // transaction, so it repeats the old count. Believing it would sign the same nonce twice.
  const node = fakeNode(3); // never advanced
  const used: number[] = [];
  const send = () =>
    sendFromSender(A, node.pendingNonce, async (nonce) => {
      used.push(nonce);
      return hashFor(nonce);
    });
  await send();
  await send();
  await send();
  expect(used).toEqual([3, 4, 5]);
});

test("the node wins when it is AHEAD of what we broadcast (another process, or a restart)", async () => {
  const node = fakeNode(0);
  const used: number[] = [];
  await sendFromSender(A, node.pendingNonce, async (n) => {
    used.push(n);
    return hashFor(n);
  });
  node.advance(); // our own
  node.advance(); // somebody else's
  await sendFromSender(A, node.pendingNonce, async (n) => {
    used.push(n);
    return hashFor(n);
  });
  expect(used).toEqual([0, 2]);
});

test("the lock is RELEASED when the section throws", async () => {
  await expect(
    withSenderLock(A, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(senderLockHeld(A)).toBe(false);
  // And the next holder actually runs, rather than waiting on a lock nobody will give back.
  await expect(withSenderLock(A, async () => "after")).resolves.toBe("after");
});

test("the lock is held INSIDE the section and released after it", async () => {
  expect(senderLockHeld(A)).toBe(false);
  await withSenderLock(A, async () => {
    expect(senderLockHeld(A)).toBe(true);
    // Per SIGNER: holding A's lock says nothing about B's.
    expect(senderLockHeld(B)).toBe(false);
  });
  expect(senderLockHeld(A)).toBe(false);
});

test("the lock key is the ADDRESS, case-insensitively", async () => {
  // A key configured under another name that happens to be the same key shares its nonce space,
  // and therefore must share its lock however it is spelled.
  await withSenderLock(A, async () => {
    expect(senderLockHeld(A.toLowerCase() as Address)).toBe(true);
  });
});

test("picking a nonce OUTSIDE the lock is refused", async () => {
  // Selection is the whole race. A caller that picks a nonce unlocked has already lost it.
  const node = fakeNode(1);
  await expect(nextSenderNonce(A, node.pendingNonce)).rejects.toThrow(/sender lock/i);
  expect(node.pendingNonce).not.toHaveBeenCalled();
});

test("`held` means held BY ME — somebody else's section does not satisfy the guard", async () => {
  // The guard's failure mode if it were a process-wide flag: an unlocked caller would pass the
  // check while the real holder was mid-section, pick the nonce that holder is about to sign, and
  // collide with it. That is the defect, reintroduced through its own guard.
  const node = fakeNode(4);
  let releaseHolder: () => void = () => {};
  const holderInside = new Promise<void>((r) => {
    releaseHolder = r;
  });
  let blocked: () => void = () => {};
  const holderMayFinish = new Promise<void>((r) => {
    blocked = r;
  });
  const holder = withSenderLock(A, async () => {
    releaseHolder();
    await holderMayFinish;
  });
  await holderInside;

  expect(senderLockHeld(A)).toBe(false); // this call holds nothing
  await expect(nextSenderNonce(A, node.pendingNonce)).rejects.toThrow(/sender lock/i);
  blocked();
  await holder;
});

test("taking the lock TWICE on one path is refused, not deadlocked", async () => {
  // `withKeyedLock` is a FIFO promise chain: the inner take would wait on the outer entry, which
  // is waiting on it. No error, no timeout, nothing in the log — so the nesting is named here.
  await expect(withSenderLock(A, () => withSenderLock(A, async () => "never"))).rejects.toThrow(
    /already held/i,
  );
  // ...and the outer lock is still released, so the key keeps working.
  await expect(withSenderLock(A, async () => "after")).resolves.toBe("after");
});

// ── The floor EXPIRES (R1) ──────────────────────────────────────────────────────────────────
//
// A stale replica and a dropped transaction tell the floor rule the same story — the node says n,
// we say n+1 — and they need opposite answers. Replica lag lasts seconds; an eviction lasts
// forever, and believing the floor through one would number every later send behind a nonce
// nothing will ever fill. So the floor is trusted for a window and then the node wins.

/** A clock the test moves by hand, installed as the module's own. */
function fakeClock(start = 1_000_000) {
  let t = start;
  resetSenderNonces(() => t);
  return {
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("WITHIN the window a stale pending read still yields nonce + 1", async () => {
  const clock = fakeClock();
  const node = fakeNode(7); // never advances: the replica has not seen our transaction
  const used: number[] = [];
  const send = () =>
    sendFromSender(A, node.pendingNonce, async (n) => {
      used.push(n);
      return hashFor(n);
    });
  await send();
  clock.advance(SENDER_FLOOR_TTL_MS - 1);
  await send();
  expect(used).toEqual([7, 8]);
});

test("AFTER the window the node is the authority again, and the floor is dropped", async () => {
  // The dropped-transaction shape: nonce 7 was accepted and then evicted, so the chain will never
  // move past it. Numbering 8, 9, 10 … behind it would strand every later send from this key until
  // a restart; reusing 7 fills the hole.
  const clock = fakeClock();
  const node = fakeNode(7);
  const used: number[] = [];
  const send = () =>
    sendFromSender(A, node.pendingNonce, async (n) => {
      used.push(n);
      return hashFor(n);
    });
  await send();
  expect(trackedSenderCount()).toBe(1);

  clock.advance(SENDER_FLOOR_TTL_MS);
  // Read the nonce without sending, so the floor is expired and dropped rather than re-noted.
  await expect(withSenderLock(A, () => nextSenderNonce(A, node.pendingNonce))).resolves.toBe(7);
  // Dropped, not merely ignored: a long-lived process must not keep an entry per key it ever used.
  expect(trackedSenderCount()).toBe(0);

  await send();
  expect(used).toEqual([7, 7]);
});

test("a broadcast late in the window REFRESHES it", async () => {
  // The window measures time since we last got a transaction onto the node, not since the first.
  const clock = fakeClock();
  const node = fakeNode(3);
  const used: number[] = [];
  const send = () =>
    sendFromSender(A, node.pendingNonce, async (n) => {
      used.push(n);
      return hashFor(n);
    });
  await send(); // floor 4, noted now
  clock.advance(SENDER_FLOOR_TTL_MS - 1_000);
  await send(); // floor 5, noted again
  clock.advance(SENDER_FLOOR_TTL_MS - 1_000); // past the FIRST note, inside the second
  await send();
  expect(used).toEqual([3, 4, 5]);
});

test("concurrent sends inside the window still get distinct consecutive nonces", async () => {
  const clock = fakeClock();
  const node = fakeNode(2);
  const used = await Promise.all(
    [0, 1, 2].map(() =>
      sendFromSender(A, node.pendingNonce, async (n) => {
        clock.advance(10); // time passes during a broadcast, but nowhere near the window
        return hashFor(n);
      }),
    ),
  );
  expect(used).toEqual([hashFor(2), hashFor(3), hashFor(4)]);
});

test("an expired floor never LOWERS the nonce: the node still wins when it is ahead", async () => {
  const clock = fakeClock();
  const node = fakeNode(0);
  await sendFromSender(A, node.pendingNonce, async (n) => hashFor(n));
  node.advance();
  node.advance(); // the chain moved past us, by our transaction and somebody else's
  clock.advance(SENDER_FLOOR_TTL_MS * 2);
  const used: number[] = [];
  await sendFromSender(A, node.pendingNonce, async (n) => {
    used.push(n);
    return hashFor(n);
  });
  expect(used).toEqual([2]);
});

test("a send for ANOTHER signer nests without complaint", async () => {
  // Two keys are two nonce spaces; only the same key's lock may not be taken twice.
  const node = fakeNode(2);
  await expect(
    withSenderLock(A, () => sendFromSender(B, node.pendingNonce, async (n) => hashFor(n))),
  ).resolves.toBe(hashFor(2));
});
