/**
 * Golden key vectors for the hand-written Hedera `Key` protobuf decoder, shared by two suites.
 *
 * The vectors were hand-built on 2026-09-10 from the Hedera protobuf `Key` layout and re-derived
 * in the audit. `A`, `B`, `C` are the compressed secp256k1 public keys of the private keys
 * `0x11…11`, `0x22…22`, `0x33…33`, re-derived with `@noble/curves`.
 *
 * Layout, for the reader: `2a` is field 5 (`ThresholdKey`) wire type 2; `08 01` its `threshold`;
 * `12 <len>` its `KeyList`; each `0a 23 3a 21 <33 bytes>` is one `Key` holding field 7
 * (`ECDSA_secp256k1`); `32` is field 6 (`KeyList`) at the top level.
 *
 * They live in a PLAIN module rather than in `test/hedera/keyDecode.test.ts` because task 5's
 * policy tests (`test/mcp/hedera.int.test.ts`) build their scripted mirror accounts from the same
 * bytes: importing them from a test file made Vitest re-register that file's own tests inside the
 * importing suite, so the MCP suite reported a count that was not its own. A second copy of the
 * bytes is still the wrong answer — the two suites have to agree byte for byte about what a 1-of-2
 * list looks like.
 */

export const A = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
export const B = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
export const C = "023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";
export const SINGLE = `3a21${A}`;
export const ONE_OF_TWO = `2a4e0801124a0a233a21${A}0a233a21${B}`;
export const TWO_OF_TWO = `324a0a233a21${A}0a233a21${B}`;
export const ONE_OF_THREE = `2a730801126f0a233a21${A}0a233a21${B}0a233a21${C}`;
export const THRESHOLD_TWO = `2a4e0802124a0a233a21${A}0a233a21${B}`;
