import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";

/**
 * SSN ENCRYPTION (design 2026-08-26 §4.2) — the only place a Social Security Number is ever in
 * plaintext in this process, and it is in plaintext for the length of one function call.
 *
 * AES-256-GCM, a fresh 12-byte IV per record stored beside the ciphertext, and the authentication
 * tag appended to the ciphertext. GCM rather than CBC because the tag is what makes a tampered
 * or truncated blob a THROW rather than a plausible-looking nine digits we would then send to
 * doola and file against a real person.
 *
 * **AAD = `party_id || company_id`.** Both exist at encryption time — the SSN rides the same
 * request that mints the company — and binding them into the additive authenticated data is what
 * stops a ciphertext being MOVED: a row copied onto another party, or another company, fails to
 * decrypt instead of silently filing one person's SSN under another person's name. It costs
 * nothing and it closes the only interesting attack on a database an operator can already read.
 *
 * **The key id is a FINGERPRINT of the key material, with a scheme PREFIX** — not a slot label.
 * That is what makes `FORMATION_PII_KEY_PREVIOUS` *selected* rather than trial-decrypted (§4.2):
 * a stored row names the key it was written with, the keyring looks that name up, and a miss is
 * an error rather than a second attempt. A slot label ("current"/"previous") would be WRONG the
 * moment a rotation happens, because the key that was current becomes the key that is previous
 * while every row it wrote still says "current".
 *
 * ⚠ STATED HONESTLY, and the runbook repeats it: the key lives in the same `.env` as everything
 * else on the box. Encryption at rest here defends the **Litestream→R2 replica** and any copy of
 * the database file that leaves the machine. It does NOT defend against a compromised box, and
 * nothing in this module pretends otherwise.
 */

/** The scheme prefix on every stored key id. Bump it if the algorithm or the AAD ever changes —
 *  a row written under the old scheme then fails to select a key, loudly, instead of decrypting
 *  to nonsense. */
const KEY_ID_PREFIX = "fpk1";

/** AES-256. 32 bytes, and nothing else is accepted. */
const KEY_BYTES = 32;
/** GCM's standard nonce length. 12 bytes is the size the construction is defined for. */
const IV_BYTES = 12;
/** GCM's authentication tag, appended to the ciphertext. */
const TAG_BYTES = 16;

/** One key, with the id every row it writes will carry. */
export interface PiiKey {
  /** `fpk1:<16 hex>` — a fingerprint of the material, so it follows the KEY, not the env slot. */
  id: string;
  key: Buffer;
}

/**
 * The keys this deployment can read with, and the one it writes with.
 *
 * `previous` exists only during a rotation window. Both are looked up BY ID; neither is ever
 * tried speculatively.
 */
export interface PiiKeyring {
  current: PiiKey;
  previous?: PiiKey;
}

/** What a row stores: the three `formation_parties.ssn_*` columns. */
export interface EncryptedSsn {
  ciphertext: Buffer;
  iv: Buffer;
  keyId: string;
}

// ── the plaintext, wrapped ──────────────────────────────────────────────────────────────────

const SECRET = Symbol("novi.secret");

/**
 * A decrypted SSN, wrapped so that the ONLY way to get the digits is to ask for them.
 *
 * The threat this closes is not malice, it is reflex. A plain `string` reaches a log line through
 * a dozen ordinary gestures nobody thinks of as logging: `JSON.stringify(body)` in a debug print,
 * `${ssn}` in an error message, `console.log(obj)` on a frame that happens to hold it, a snapshot
 * assertion in a test, an APM breadcrumb. Every one of those goes through `toString`, `toJSON` or
 * `util.inspect`, and all three of them answer `"[redacted]"` here.
 *
 * `reveal()` is the single deliberate exit, and it has exactly ONE caller: `buildCompanyInput`,
 * at the wire boundary, where the value is placed into the body doola is about to receive. A
 * second caller is a review question, which is the point — `grep -rn "\.reveal()"` is the whole
 * audit.
 */
export interface Secret {
  readonly [SECRET]: true;
  /** The plaintext. The ONE deliberate exit — see the interface comment. */
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

/** The redacted stand-in every accidental stringification produces. */
const REDACTED = "[redacted]";

/**
 * Wrap a plaintext value.
 *
 * The digits live in the closure, not on the object, so there is no property for a spread, a
 * structured clone or a snapshot serializer to find: `{...secret}` is `{}` and
 * `JSON.stringify({ssn: secret})` is `{"ssn":"[redacted]"}`.
 */
export function toSecret(value: string): Secret {
  const self: Secret = {
    [SECRET]: true,
    reveal: () => value,
    toString: () => REDACTED,
    toJSON: () => REDACTED,
  };
  // `util.inspect` is what `console.log(obj)` and vitest's diff both go through, and it ignores
  // `toString`. Defined non-enumerably so it does not itself show up in a serialization.
  Object.defineProperty(self, inspect.custom, { value: () => REDACTED, enumerable: false });
  return self;
}

/**
 * Parse one env value into a key.
 *
 * Accepts base64 or hex, because an operator generating 32 bytes reaches for `openssl rand` in
 * one of those two forms and a "your key is the wrong length" error at boot is worth more than a
 * strict format nobody remembers. Anything that does not decode to EXACTLY 32 bytes throws, with
 * the variable named — a 31-byte key is a typo, and a silently padded one is a key nobody can
 * reproduce.
 */
export function parsePiiKey(raw: string, varName: string): PiiKey {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Invalid config: ${varName} is empty`);
  const decoded = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (decoded.length !== KEY_BYTES)
    throw new Error(
      `Invalid config: ${varName} must decode to exactly ${KEY_BYTES} bytes (AES-256) — got ${decoded.length}. Generate one with: openssl rand -base64 32`,
    );
  return { id: keyId(decoded), key: decoded };
}

/**
 * The key's id: a scheme prefix plus a truncated SHA-256 of the material.
 *
 * A fingerprint of the KEY, deliberately — see the module comment. Truncated to 64 bits because
 * this is a lookup handle inside our own keyring, not a security boundary: the only thing an id
 * collision could do is select the wrong key, and the GCM tag then fails the decrypt.
 *
 * Publishing a fingerprint of a secret is safe at this length and this construction (a
 * preimage on SHA-256 is not made easier by 8 bytes of it), and it is what makes a rotation
 * auditable: two ids in the ops trail is how an operator sees the rotation actually happening.
 */
function keyId(key: Buffer): string {
  return `${KEY_ID_PREFIX}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * The AAD: the party and the company this ciphertext belongs to, and nothing else.
 *
 * `|` is a separator neither a uuid nor a doola id contains, so no pair of (party, company) can
 * produce the same bytes as another pair.
 */
function aad(partyId: string, companyId: string): Buffer {
  return Buffer.from(`${partyId}|${companyId}`, "utf8");
}

/**
 * ENCRYPT an SSN for one (party, company).
 *
 * Always with `keyring.current`: `previous` exists to READ rows written before a rotation, and
 * writing with it would extend the window it exists to close.
 *
 * It takes a PLAIN string, not a `Secret`, and the asymmetry with `decryptSsn` is deliberate:
 * this is the direction where the value has just arrived from a door and has not been anywhere
 * yet, so wrapping it here would be ceremony over a value that is about to stop existing. The
 * wrapper exists for the OTHER direction, where a decrypted value is handed to code that will
 * carry it through a call stack.
 */
export function encryptSsn(
  keyring: PiiKeyring,
  ssn: string,
  bind: { partyId: string; companyId: string },
): EncryptedSsn {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.current.key, iv);
  cipher.setAAD(aad(bind.partyId, bind.companyId));
  const body = Buffer.concat([cipher.update(ssn, "utf8"), cipher.final()]);
  // Tag APPENDED, so the row keeps three columns rather than four and a partial write cannot
  // separate a ciphertext from the tag that authenticates it.
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv, keyId: keyring.current.id };
}

/**
 * Decrypt, SELECTING the key by its stored id.
 *
 * Never a trial decrypt: an unknown id is an error naming the id, not a silent second attempt.
 * The distinction matters operationally — "this row was written with a key this box does not
 * have" is an answerable question ("did somebody forget FORMATION_PII_KEY_PREVIOUS?"), while
 * "decryption failed" after two attempts is not.
 *
 * THROWS on any failure, and the message never contains plaintext, ciphertext or key material.
 * The caller's only correct reaction is to refuse to send a body — never to send one WITHOUT the
 * SSN, which under a live idempotency key is a different body (see formationProvider).
 *
 * Returns a `Secret`, not a string: from here the value travels through a call stack, and every
 * accidental stringification on the way answers `"[redacted]"`.
 */
export function decryptSsn(
  keyring: PiiKeyring,
  stored: EncryptedSsn,
  bind: { partyId: string; companyId: string },
): Secret {
  const key = selectKey(keyring, stored.keyId);
  if (!key)
    throw new Error(
      `no PII key with id ${stored.keyId} is configured on this deployment (FORMATION_PII_KEY / FORMATION_PII_KEY_PREVIOUS)`,
    );
  if (stored.iv.length !== IV_BYTES) throw new Error("stored SSN has a malformed IV");
  if (stored.ciphertext.length < TAG_BYTES) throw new Error("stored SSN is truncated");
  const body = stored.ciphertext.subarray(0, stored.ciphertext.length - TAG_BYTES);
  const tag = stored.ciphertext.subarray(stored.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key.key, stored.iv);
  decipher.setAAD(aad(bind.partyId, bind.companyId));
  decipher.setAuthTag(tag);
  // `final()` is what verifies the tag; a wrong key, a moved row or a tampered blob all throw
  // here rather than returning bytes.
  return toSecret(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

/**
 * Exact-id lookup over the two candidates.
 *
 * A plain `===`. It used to be a `timingSafeEqual`, which was ceremony: a key ID is a PUBLISHED
 * value (it is written into every row it keys and printed in the ops trail), the comparison is
 * against at most two candidates, and there is no secret whose bytes a timing signal could
 * recover — the whole point of the fingerprint scheme is that the id is safe to know.
 */
function selectKey(keyring: PiiKeyring, id: string): PiiKey | undefined {
  for (const k of [keyring.current, keyring.previous]) if (k && k.id === id) return k;
  return undefined;
}

// ── format ─────────────────────────────────────────────────────────────────────────────────

/**
 * doola's documented format: `XXX-XX-XXXX` (OpenAPI `PartnerResponsiblePartyDto.ssn`, fetched
 * 2026-08-31 — "Social Security Number or ITIN. Optional. Format: XXX-XX-XXXX.").
 *
 * Validated at the DOOR, before anything is encrypted, so a typo is a specific 400 rather than a
 * blob we cannot inspect later and a doola `rejected` on a real fee. Deliberately NOT normalizing
 * a bare nine digits into the dashed form: an SSN is not ours to reformat, and a caller who typed
 * nine digits may equally have typed eight and a stray one.
 */
const SSN_PATTERN = /^\d{3}-\d{2}-\d{4}$/;

export function isWellFormedSsn(value: string): boolean {
  return SSN_PATTERN.test(value);
}
