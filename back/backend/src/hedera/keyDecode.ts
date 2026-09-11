/**
 * A hand-written reader for the Hedera protobuf `Key` message.
 *
 * WHY HAND-WRITTEN (design D24). The server keeps its Hedera surface to REST and never constructs
 * SDK transaction objects: signing happens in the client, the server only ever *reads*. So there
 * is no SDK on the server's dependency list to decode with — `@hiero-ledger/sdk` sits in
 * `node_modules` purely as `@x402/hedera`'s transitive dependency and is imported by nothing under
 * `src/`. Reaching into it here would promote a transitive dependency into a load-bearing one and
 * pull a full consensus-node client (and its key material handling) into a process that wants
 * neither. The mirror node hands key lists back as `_type: "ProtobufEncoded"` hex and nothing else,
 * so the choice is: decode ~60 lines of length-delimited protobuf ourselves, or take the SDK.
 * We decode.
 *
 * The slice of the schema that matters, from Hedera's `basic_types.proto`:
 *
 *   Key { 2: bytes ed25519; 5: ThresholdKey; 6: KeyList; 7: bytes ECDSA_secp256k1 }
 *   ThresholdKey { 1: uint32 threshold; 2: KeyList keys }
 *   KeyList { 1: repeated Key keys }
 *
 * `Key` is a oneof, so exactly one field is set. Field numbers this reader does not handle
 * (`contractID`, `delegatableContractId`, `RSA_3072`, `ECDSA_384`) THROW rather than decode to
 * something friendly: an account secured by a contract key is not an account whose signer set the
 * policy engine can reason about, and quietly reporting it as "no key" would read, downstream, as
 * an unsecured account. A loud failure is the only honest answer.
 */

/** A Hedera key as the policy engine consumes it: one key, an m-of-n, or a plain list (n-of-n). */
export type DecodedKey =
  | { kind: "single"; keyHex: string }
  | { kind: "threshold"; threshold: number; keys: DecodedKey[] }
  | { kind: "list"; keys: DecodedKey[] };

/** Field numbers, named so the switch below reads as the schema rather than as magic numbers. */
const FIELD = { ed25519: 2, thresholdKey: 5, keyList: 6, ecdsaSecp256k1: 7 } as const;
const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

/** A cursor over one protobuf message. Only the two wire types the `Key` schema uses are read. */
class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** A base-128 varint. Multiplication, not `<<`, so a long varint cannot wrap at 32 bits. */
  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) throw new Error("truncated varint in Hedera key");
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new Error("varint too long in Hedera key");
    }
  }

  /** A length-delimited field's payload. */
  bytes(): Uint8Array {
    const len = this.varint();
    const end = this.pos + len;
    if (end > this.buf.length) throw new Error("truncated length-delimited field in Hedera key");
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error("odd-length hex in Hedera key");
  if (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body))
    throw new Error("non-hex character in Hedera key");
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** `KeyList { 1: repeated Key }`. */
function readKeyList(buf: Uint8Array): DecodedKey[] {
  const reader = new Reader(buf);
  const keys: DecodedKey[] = [];
  while (!reader.done) {
    const tag = reader.varint();
    if (tag >> 3 !== 1 || (tag & 7) !== WIRE_LENGTH_DELIMITED)
      throw new Error(`unsupported key list field ${tag >> 3}`);
    keys.push(readKey(reader.bytes()));
  }
  return keys;
}

/** `ThresholdKey { 1: uint32 threshold; 2: KeyList keys }`. */
function readThresholdKey(buf: Uint8Array): DecodedKey {
  const reader = new Reader(buf);
  let threshold = 0;
  let keys: DecodedKey[] = [];
  while (!reader.done) {
    const tag = reader.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_VARINT) threshold = reader.varint();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) keys = readKeyList(reader.bytes());
    else throw new Error(`unsupported threshold key field ${field}`);
  }
  return { kind: "threshold", threshold, keys };
}

/** One `Key`. Exactly one field is set; anything after it is a message this reader misread. */
function readKey(buf: Uint8Array): DecodedKey {
  const reader = new Reader(buf);
  const tag = reader.varint();
  const field = tag >> 3;
  if ((tag & 7) !== WIRE_LENGTH_DELIMITED) throw new Error(`unsupported key field ${field}`);

  let key: DecodedKey;
  switch (field) {
    // ed25519 and ECDSA both decode to `single`; the caller tells them apart by length — 64 hex
    // characters is an ed25519 public key, 66 a compressed secp256k1 one.
    case FIELD.ed25519:
    case FIELD.ecdsaSecp256k1:
      key = { kind: "single", keyHex: bytesToHex(reader.bytes()) };
      break;
    case FIELD.thresholdKey:
      key = readThresholdKey(reader.bytes());
      break;
    case FIELD.keyList:
      key = { kind: "list", keys: readKeyList(reader.bytes()) };
      break;
    default:
      throw new Error(`unsupported key field ${field}`);
  }
  if (!reader.done) throw new Error("trailing bytes after Hedera key");
  return key;
}

/**
 * Decode the mirror node's `key.key` hex (its `_type` is `ProtobufEncoded`) into a `DecodedKey`.
 * Accepts the bare hex the mirror node returns and a `0x`-prefixed form alike.
 */
export function decodeHederaKey(hex: string): DecodedKey {
  return readKey(hexToBytes(hex));
}
