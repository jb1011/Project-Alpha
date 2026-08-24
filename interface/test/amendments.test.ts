/**
 * Which hashes the guardian's veto card asks the CONTRACT about (design §8, audit H4).
 *
 * The bug this encodes: the card derived its `scheduledAt`/`vetoed` reads from the
 * `AmendmentScheduled` log scan alone. That scan falls back to a bounded window whenever an RPC
 * refuses `fromBlock: 0`, and an amendment timelock can be set to a year — so a genuinely live
 * amendment older than the window simply did not appear, and the card told the guardian "nothing
 * with that hash is scheduled on this contract… nothing to veto until it does".
 *
 * A point read against a mapping needs no range at all.
 */
import { expect, test } from "vitest";
import { collectAmendmentHashes, sameHash } from "@/lib/amendments";

const A = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as const;
const B = "0xbbbb000000000000000000000000000000000000000000000000000000000002" as const;

test("G3: the API's pending hash is read even when NO log turned it up", () => {
  // The truncated-window case, and the one that produced the false reassurance.
  expect(collectAmendmentHashes([], A)).toEqual([A]);
  expect(collectAmendmentHashes([B], A)).toEqual([B, A]);
});

test("G3: discovered hashes still come from the logs — the API does not gate them", () => {
  // The other half of the point: the log scan finds hashes the platform is not talking about,
  // which is the superseded/abandoned amendment a guardian most wants to see.
  expect(collectAmendmentHashes([A, B], null)).toEqual([A, B]);
});

test("G3: a hash reported by both sources is read once", () => {
  expect(collectAmendmentHashes([A, B], A)).toEqual([A, B]);
  // …including when the two sources disagree on casing, which they do: logs come back lowercase
  // and the API's column is whatever was written into it.
  expect(collectAmendmentHashes([A], A.toUpperCase().replace("0X", "0x"))).toEqual([A]);
});

test("G3: duplicate log entries collapse — a rescheduled hash appears once", () => {
  expect(collectAmendmentHashes([A, A, B, A], null)).toEqual([A, B]);
});

test("G3: hashes compare by value, never by identity or case", () => {
  expect(sameHash(A, A.toUpperCase().replace("0X", "0x"))).toBe(true);
  expect(sameHash(A, B)).toBe(false);
});
