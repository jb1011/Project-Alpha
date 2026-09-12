/**
 * The EIP-712 signature over a `/verify` attestation (task 13, design Component 3, audit C12).
 *
 * What this file is for: the signature is the ONLY part of the served document a verifier can
 * check without trusting us, so the thing under test is not "does signing work" but "do the
 * signer and the verifier flatten the same body to the same twelve fields". Every test below is
 * a way of pulling those two apart — a flipped field, a null that maps to a sentinel, a sentinel
 * that a real value must not collide with.
 *
 * THE KEY BELOW IS A TEST VECTOR, not a secret: Anvil's public account 1, printed in Foundry's
 * own documentation and funded on nothing.
 */
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import {
  ATTESTATION_DOMAIN,
  ATTESTATION_TYPES,
  type AttestationBody,
  attestationMessage,
  signAttestation,
  verifyAttestation,
} from "../../src/hedera/attestation";
import type { Hex } from "../../src/types";

/** Anvil's public account 1. A published test vector; never a deployment key. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ATTESTOR = privateKeyToAccount(KEY).address;
/** A DIFFERENT published test vector (Anvil account 2), for "signed by someone else". */
const OTHER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";
const TREASURY = "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf";
const OA_HASH = `0x${"11".repeat(32)}` as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

/** A fully populated body: every one of the four nullable fields carries a real value, so a test
 *  that wants the null path has to ask for it. */
const body = (over: Partial<AttestationBody> = {}): AttestationBody => ({
  subject: {
    publicId: PUBLIC_ID,
    name: "FormationE2E_1",
    agentId: "886257",
    registry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    treasury: TREASURY,
    uaid: "uaid:aid:0x1234;uid=886257",
  },
  standing: "active",
  formation: { filed: true, einIssued: true, status: "complete", environment: "production" },
  controller: { humanVerified: true, credential: "orb" },
  legalBody: { oaHash: OA_HASH, manifestVersion: 3 },
  issuedAt: "2026-09-10T08:13:20.000Z",
  issuedAtUnix: "1789100000",
  expiresAt: "2026-09-10T08:18:20.000Z",
  expiresAtUnix: "1789100300",
  ...over,
});

// ── the typed data itself ───────────────────────────────────────────────────────────────────────

test("the domain is the naming table's, with no chainId and no verifyingContract", () => {
  expect(ATTESTATION_DOMAIN).toEqual({ name: "Novi Corpus Attestation", version: "1" });
});

test("the primary type is the twelve flattened fields, in order", () => {
  expect(Object.keys(ATTESTATION_TYPES)).toEqual(["LegalBodyAttestation"]);
  expect(ATTESTATION_TYPES.LegalBodyAttestation).toEqual([
    { name: "publicId", type: "string" },
    { name: "agentId", type: "string" },
    { name: "treasury", type: "address" },
    { name: "uaid", type: "string" },
    { name: "standing", type: "string" },
    { name: "formationStatus", type: "string" },
    { name: "formationEnvironment", type: "string" },
    { name: "humanVerified", type: "bool" },
    { name: "oaHash", type: "bytes32" },
    { name: "manifestVersion", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ]);
});

test("the message is the body flattened, with the unix seconds as the timestamps", () => {
  expect(attestationMessage(body())).toEqual({
    publicId: PUBLIC_ID,
    agentId: "886257",
    treasury: TREASURY,
    uaid: "uaid:aid:0x1234;uid=886257",
    standing: "active",
    formationStatus: "complete",
    formationEnvironment: "production",
    humanVerified: true,
    oaHash: OA_HASH,
    manifestVersion: 3n,
    issuedAt: 1_789_100_000n,
    expiresAt: 1_789_100_300n,
  });
});

// ── sign, then verify ───────────────────────────────────────────────────────────────────────────

test("a signed attestation verifies under viem's own verifyTypedData", async () => {
  const b = body();
  const { attestor, signature } = await signAttestation(b, KEY);
  expect(attestor).toBe(ATTESTOR);
  expect(
    await verifyTypedData({
      address: attestor,
      domain: ATTESTATION_DOMAIN,
      types: ATTESTATION_TYPES,
      primaryType: "LegalBodyAttestation",
      message: attestationMessage(b),
      signature,
    }),
  ).toBe(true);
});

test("verifyAttestation recomputes the typed data from the body and agrees", async () => {
  const b = body();
  const { attestor, signature } = await signAttestation(b, KEY);
  expect(await verifyAttestation(b, attestor, signature)).toBe(true);
});

test("flipping standing after signing fails verification", async () => {
  const b = body();
  const { attestor, signature } = await signAttestation(b, KEY);
  expect(await verifyAttestation({ ...b, standing: "inactive" }, attestor, signature)).toBe(false);
});

test("every signed field is covered: flipping any one of them fails verification", async () => {
  const b = body();
  const { attestor, signature } = await signAttestation(b, KEY);
  const tampered: AttestationBody[] = [
    { ...b, subject: { ...b.subject, publicId: "00000000-0000-0000-0000-000000000000" } },
    { ...b, subject: { ...b.subject, agentId: "886258" } },
    { ...b, subject: { ...b.subject, treasury: "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE" } },
    { ...b, subject: { ...b.subject, uaid: "uaid:aid:0x9999;uid=886257" } },
    { ...b, standing: "unknown" },
    { ...b, formation: { ...b.formation!, status: "filed" } },
    { ...b, formation: { ...b.formation!, environment: "sandbox" } },
    { ...b, controller: { ...b.controller, humanVerified: false } },
    { ...b, legalBody: { ...b.legalBody, oaHash: `0x${"22".repeat(32)}` as Hex } },
    { ...b, legalBody: { ...b.legalBody, manifestVersion: 4 } },
    { ...b, issuedAtUnix: "1789100001" },
    { ...b, expiresAtUnix: "1789100301" },
  ];
  expect(tampered).toHaveLength(ATTESTATION_TYPES.LegalBodyAttestation.length);
  for (const t of tampered) expect(await verifyAttestation(t, attestor, signature)).toBe(false);
});

test("a body signed by a different key does not verify against our attestor", async () => {
  const b = body();
  const { signature } = await signAttestation(b, OTHER_KEY);
  expect(await verifyAttestation(b, ATTESTOR, signature)).toBe(false);
});

test("a malformed signature is false, never a thrown error", async () => {
  expect(await verifyAttestation(body(), ATTESTOR, "0xdeadbeef" as Hex)).toBe(false);
});

// ── the null mapping (design Component 3, audit C12) ────────────────────────────────────────────

/** The body a deployment serves before the anchor sub-saga, the HCS-14 write and the Arc
 *  registration have run: all four nullable fields empty at once. */
const allNull = () =>
  body({
    subject: { ...body().subject, agentId: null, uaid: null },
    legalBody: { oaHash: null, manifestVersion: null },
  });

test("all four nullable fields null: the sentinels are what gets signed", () => {
  expect(attestationMessage(allNull())).toMatchObject({
    agentId: "",
    uaid: "",
    oaHash: ZERO_BYTES32,
    manifestVersion: 0n,
  });
});

test("a body with all four null signs and verifies", async () => {
  const b = allNull();
  const { attestor, signature } = await signAttestation(b, KEY);
  expect(await verifyAttestation(b, attestor, signature)).toBe(true);
});

test("moving oaHash off the zero sentinel fails verification", async () => {
  const b = allNull();
  const { attestor, signature } = await signAttestation(b, KEY);
  const swapped = { ...b, legalBody: { ...b.legalBody, oaHash: OA_HASH } };
  expect(await verifyAttestation(swapped, attestor, signature)).toBe(false);
});

test("a null formation signs as two empty strings, and a filed one does not collide with it", async () => {
  const b = body({ formation: null });
  expect(attestationMessage(b)).toMatchObject({ formationStatus: "", formationEnvironment: "" });
  const { attestor, signature } = await signAttestation(b, KEY);
  expect(await verifyAttestation(b, attestor, signature)).toBe(true);
  const filed = body({
    formation: { filed: true, einIssued: false, status: "filed", environment: "production" },
  });
  expect(await verifyAttestation(filed, attestor, signature)).toBe(false);
});

// ── the golden vector (PR 3 review, I2) ─────────────────────────────────────────────────────────

/**
 * The drift guard between this package and `back/hedera-client`.
 *
 * The client carries a COPY of the domain, the twelve types and the flattener, and until now
 * each suite signed and verified with its own copy — so a renamed field or a changed sentinel in
 * either one passed both suites and every demo signature read as invalid at the recording. The
 * fixed body and the hard-coded signature below also live in `back/hedera-client/test/attest.test.ts`;
 * change either copy of the shape and one of the two suites fails.
 *
 * Anvil's published dev account 0. A test vector printed in Foundry's own documentation, funded
 * on nothing, and never a deployment key.
 */
const GOLDEN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const GOLDEN_ATTESTOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

/** The fixed body both packages sign. Every field is also in `back/hedera-client/test/attest.test.ts`. */
const goldenBody = (): AttestationBody => ({
  subject: {
    publicId: "9f8003f5-4c70-435a-9980-9a54625691b7",
    name: "FormationE2E_1",
    agentId: "886257",
    registry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    treasury: "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf",
    uaid: "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk",
  },
  standing: "active",
  formation: { filed: true, einIssued: true, status: "complete", environment: "production" },
  controller: { humanVerified: true, credential: "orb" },
  legalBody: {
    oaHash: "0x74aa4be2a56224b200da228e61bb1f06dfebfa6a78269988b1627b345a639930",
    manifestVersion: 3,
  },
  issuedAt: "2026-09-12T01:58:40.000Z",
  issuedAtUnix: "1789178320",
  expiresAt: "2026-09-12T02:03:40.000Z",
  expiresAtUnix: "1789178620",
});

// The same literal is pinned in `back/hedera-client/test/attest.test.ts`: if either package's
// copy of the attestation shape drifts, one of the two suites stops reproducing or accepting it.
const GOLDEN_SIGNATURE =
  "0x086d3f329535207f514a922585edf576587ead89b6c7b88c56d4e019ecd34a804f0aeb1df13fbc27f44d83578b7e837edb3faa7617aa428e3df4dc04d10f05e41b" as Hex;

test("signAttestation reproduces the golden signature byte for byte", async () => {
  const { attestor, signature } = await signAttestation(goldenBody(), GOLDEN_KEY);
  expect(attestor).toBe(GOLDEN_ATTESTOR);
  expect(signature).toBe(GOLDEN_SIGNATURE);
});

test("verifyAttestation accepts the golden vector, and rejects it once standing is flipped", async () => {
  expect(await verifyAttestation(goldenBody(), GOLDEN_ATTESTOR, GOLDEN_SIGNATURE)).toBe(true);
  const tampered = { ...goldenBody(), standing: "inactive" as const };
  expect(await verifyAttestation(tampered, GOLDEN_ATTESTOR, GOLDEN_SIGNATURE)).toBe(false);
});
