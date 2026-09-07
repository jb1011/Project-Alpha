/**
 * SSN encryption (design 2026-08-26 §4.2).
 *
 * Four properties carry the whole of the design's claim, and each of them is a real failure mode
 * rather than a property of AES:
 *
 *  1. a ciphertext is bound to its (party, company) by the AAD, so a row MOVED between people or
 *     between filings fails to decrypt instead of filing one person's SSN under another's name;
 *  2. the key is SELECTED by the id stored on the row, never trial-decrypted — a rotation is a
 *     lookup, and a missing key is an answerable error;
 *  3. the key id follows the KEY, not the env slot, so yesterday's rows still name yesterday's
 *     key after it moves from FORMATION_PII_KEY to FORMATION_PII_KEY_PREVIOUS;
 *  4. tampering throws.
 */
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import {
  type PiiKeyring,
  decryptSsn,
  encryptSsn,
  isWellFormedSsn,
  parsePiiKey,
  toSecret,
} from "../../src/formation/pii";

const SSN = "123-45-6789";
const BIND = { partyId: "party-1", companyId: "company-1" };

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function ring(current: string, previous?: string): PiiKeyring {
  return {
    current: parsePiiKey(current, "FORMATION_PII_KEY"),
    previous: previous ? parsePiiKey(previous, "FORMATION_PII_KEY_PREVIOUS") : undefined,
  };
}

test("round trips, and every record gets its own IV", () => {
  const k = ring(KEY_A);
  const one = encryptSsn(k, SSN, BIND);
  const two = encryptSsn(k, SSN, BIND);
  expect(decryptSsn(k, one, BIND).reveal()).toBe(SSN);
  expect(decryptSsn(k, two, BIND).reveal()).toBe(SSN);
  expect(one.iv).toHaveLength(12);
  // Same plaintext, same key, DIFFERENT bytes — an IV reuse under GCM is catastrophic, and this
  // is the cheapest possible assertion that it is not happening.
  expect(one.iv.equals(two.iv)).toBe(false);
  expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
});

test("the AAD binds the row: a ciphertext MOVED to another party or company will not open", () => {
  const k = ring(KEY_A);
  const rec = encryptSsn(k, SSN, BIND);
  expect(() => decryptSsn(k, rec, { partyId: "party-2", companyId: "company-1" })).toThrow();
  expect(() => decryptSsn(k, rec, { partyId: "party-1", companyId: "company-2" })).toThrow();
  // …and the separator is not forgeable by shifting the boundary between the two ids.
  expect(() => decryptSsn(k, rec, { partyId: "party", companyId: "1|company-1" })).toThrow();
});

test("the key is SELECTED by the stored id — a PREVIOUS key opens an old row, and only it", () => {
  const oldRing = ring(KEY_A);
  const written = encryptSsn(oldRing, SSN, BIND);

  // The rotation: yesterday's key moves to _PREVIOUS, a new one becomes current.
  const rotated = ring(KEY_B, KEY_A);
  expect(decryptSsn(rotated, written, BIND).reveal()).toBe(SSN);
  // New writes use CURRENT, never previous — that is what closes the rotation window.
  expect(encryptSsn(rotated, SSN, BIND).keyId).toBe(rotated.current.id);
  expect(rotated.current.id).not.toBe(rotated.previous!.id);

  // The id follows the KEY, not the slot: the row written yesterday still names the same id
  // today, which is the whole reason selection works across a rotation.
  expect(written.keyId).toBe(rotated.previous!.id);
});

test("a key this box does not have is a NAMED error, never a trial decrypt", () => {
  const written = encryptSsn(ring(KEY_A), SSN, BIND);
  // Only KEY_B configured. The point is that we do not TRY it: we look the id up and fail.
  expect(() => decryptSsn(ring(KEY_B), written, BIND)).toThrow(/no PII key with id fpk1:/);
});

test("tampering with the ciphertext, the tag or the IV throws", () => {
  const k = ring(KEY_A);
  const rec = encryptSsn(k, SSN, BIND);

  const flip = (b: Buffer, i: number) => {
    const copy = Buffer.from(b);
    copy[i] = copy[i]! ^ 0x01;
    return copy;
  };
  expect(() => decryptSsn(k, { ...rec, ciphertext: flip(rec.ciphertext, 0) }, BIND)).toThrow();
  // The last 16 bytes are the tag.
  expect(() =>
    decryptSsn(k, { ...rec, ciphertext: flip(rec.ciphertext, rec.ciphertext.length - 1) }, BIND),
  ).toThrow();
  expect(() => decryptSsn(k, { ...rec, iv: flip(rec.iv, 0) }, BIND)).toThrow();
  // …and a truncated blob is refused before the cipher ever sees it.
  expect(() => decryptSsn(k, { ...rec, ciphertext: rec.ciphertext.subarray(0, 4) }, BIND)).toThrow(
    /truncated/,
  );
  expect(() => decryptSsn(k, { ...rec, iv: rec.iv.subarray(0, 4) }, BIND)).toThrow(/malformed IV/);
});

test("no error message ever carries the plaintext, the key or the ciphertext", () => {
  const k = ring(KEY_A);
  const rec = encryptSsn(k, SSN, BIND);
  const messages: string[] = [];
  for (const attempt of [
    () => decryptSsn(ring(KEY_B), rec, BIND),
    () => decryptSsn(k, rec, { partyId: "other", companyId: "other" }),
    () => decryptSsn(k, { ...rec, ciphertext: rec.ciphertext.subarray(0, 2) }, BIND),
  ]) {
    try {
      attempt();
      throw new Error("expected a throw");
    } catch (e) {
      messages.push((e as Error).message);
    }
  }
  for (const m of messages) {
    expect(m).not.toContain(SSN);
    expect(m).not.toContain("6789");
    expect(m).not.toContain(KEY_A);
    expect(m).not.toContain(rec.ciphertext.toString("base64"));
    // The key ID is a FINGERPRINT and may appear (it is how an operator answers "which key?"),
    // but never anything that reconstructs the key.
    expect(m).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  }
});

// ── key parsing ────────────────────────────────────────────────────────────────────────────

test("a key is 32 bytes, base64 or hex, and anything else fails at BOOT with the var named", () => {
  const raw = randomBytes(32);
  expect(parsePiiKey(raw.toString("base64"), "FORMATION_PII_KEY").key.equals(raw)).toBe(true);
  expect(parsePiiKey(raw.toString("hex"), "FORMATION_PII_KEY").key.equals(raw)).toBe(true);
  // …and the two spellings of ONE key produce ONE id, so a re-encoding is not a rotation.
  expect(parsePiiKey(raw.toString("base64"), "X").id).toBe(
    parsePiiKey(raw.toString("hex"), "X").id,
  );

  for (const bad of ["", "   ", randomBytes(31).toString("base64"), "not-a-key"])
    expect(() => parsePiiKey(bad, "FORMATION_PII_KEY"), bad).toThrow(/FORMATION_PII_KEY/);
});

test("the key id carries the scheme prefix, so a scheme change cannot decrypt to nonsense", () => {
  expect(parsePiiKey(KEY_A, "X").id).toMatch(/^fpk1:[0-9a-f]{16}$/);
});

// ── format ─────────────────────────────────────────────────────────────────────────────────

test("the SSN format is doola's documented XXX-XX-XXXX, and nothing is auto-reformatted", () => {
  expect(isWellFormedSsn("123-45-6789")).toBe(true);
  // A bare nine digits is REFUSED rather than reformatted: an SSN is not ours to rewrite, and a
  // caller who typed nine digits may equally have typed eight and a stray one.
  for (const bad of [
    "123456789",
    "123-45-678",
    "123-45-67890",
    "12-345-6789",
    "abc-de-fghi",
    " 123-45-6789 ",
    "",
  ])
    expect(isWellFormedSsn(bad), bad).toBe(false);
});

// ── the Secret wrapper ─────────────────────────────────────────────────────────────────────

test("a decrypted SSN cannot be stringified by ACCIDENT — only by asking", () => {
  const k = ring(KEY_A);
  const secret = decryptSsn(k, encryptSsn(k, SSN, BIND), BIND);

  // The three gestures that reach a log line without anybody meaning to.
  expect(`${secret}`).toBe("[redacted]");
  expect(String(secret)).toBe("[redacted]");
  expect(JSON.stringify(secret)).toBe('"[redacted]"');
  expect(inspect(secret)).toBe("[redacted]");

  // …including when it is a FIELD of something bigger, which is how it actually travels: a
  // request body, a log object, a test snapshot. NO DIGITS, at all, anywhere in the output.
  for (const carrier of [
    { responsibleParty: { ssn: secret } },
    [secret],
    { nested: { deep: { ssn: secret } } },
  ]) {
    const printed = JSON.stringify(carrier);
    expect(printed).not.toContain(SSN);
    expect(printed, printed).not.toMatch(/\d/);
  }
  // A SPREAD cannot free them either: the digits live in a closure rather than in a property,
  // and the copy carries the same redacting `toJSON`.
  expect(JSON.stringify({ ...secret })).toBe('"[redacted]"');

  // And the one deliberate exit still works — that is what the wire boundary calls.
  expect(secret.reveal()).toBe(SSN);
});

test("toSecret wraps any value the same way", () => {
  expect(`${toSecret("123-45-6789")}`).toBe("[redacted]");
  expect(toSecret("x").reveal()).toBe("x");
});
