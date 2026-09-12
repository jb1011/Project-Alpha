import { privateKeyToAccount } from "viem/accounts";
// The offline attestation check, with a synthetic signer. No network, no real attestation key.
// Two claims: a body signed over the twelve flattened fields verifies, and a body whose
// `standing` was flipped after signing does not — which is the whole point of serving a
// signature beside the document.
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_DOMAIN,
  ATTESTATION_TYPES,
  type AttestationBody,
  attestationMessage,
  verifyAttestation,
} from "../src/attest.js";

/** Anvil's public account 1. A published test key, never a Novi Corpus key. */
const SYNTHETIC_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const body = (over: Partial<AttestationBody> = {}): AttestationBody => ({
  subject: {
    publicId: "9f8003f5-4c70-435a-9980-9a54625691b7",
    name: "FormationE2E_1",
    agentId: "886257",
    registry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    treasury: "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf",
    uaid: "uaid:aid:7yCVPN2iLzHZ244fEcpayKQbhzHaMVWhEZgWZoessWWnP13s19RKoa8YEB4kXEazJk",
  },
  standing: "active",
  formation: { status: "complete", environment: "production" },
  controller: { humanVerified: true, credential: "orb" },
  legalBody: { oaHash: null, manifestVersion: null },
  issuedAt: "2026-09-12T00:00:00.000Z",
  issuedAtUnix: "1789171200",
  expiresAt: "2026-09-12T00:05:00.000Z",
  expiresAtUnix: "1789171500",
  ...over,
});

/** Signs a body the way the server does, so the test exercises the shared flattener. */
async function sign(b: AttestationBody) {
  const account = privateKeyToAccount(SYNTHETIC_KEY);
  const signature = await account.signTypedData({
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "LegalBodyAttestation",
    message: attestationMessage(b),
  });
  return { attestor: account.address, signature };
}

describe("verifyAttestation", () => {
  it("accepts a body signed by the attestor it names", async () => {
    const b = body();
    const { attestor, signature } = await sign(b);
    expect(await verifyAttestation(b, attestor, signature)).toBe(true);
  });

  it("rejects a body whose standing was flipped after signing", async () => {
    const b = body();
    const { attestor, signature } = await sign(b);
    const tampered = body({ standing: "inactive" });
    expect(await verifyAttestation(tampered, attestor, signature)).toBe(false);
  });

  it("returns false rather than throwing on a malformed signature", async () => {
    const b = body();
    const { attestor } = await sign(b);
    expect(await verifyAttestation(b, attestor, "0xdeadbeef")).toBe(false);
  });

  it("maps the nullable fields to their sentinels", () => {
    const m = attestationMessage(
      body({ subject: { ...body().subject, uaid: null, agentId: null } }),
    );
    expect(m.uaid).toBe("");
    expect(m.agentId).toBe("");
    expect(m.oaHash).toBe(`0x${"0".repeat(64)}`);
    expect(m.manifestVersion).toBe(0n);
  });
});

// ── the golden vector (PR 3 review, I2) ─────────────────────────────────────────────────────────

/**
 * The drift guard between this package and `back/backend`.
 *
 * This file's copy of the domain, the twelve types and the flattener is a copy: until now each
 * suite signed and verified with its own, so a renamed field or a changed sentinel in either one
 * passed both suites and every demo signature read as invalid at the recording. The fixed body
 * and the hard-coded signature below also live in `back/backend/test/hedera/attestation.test.ts`,
 * where the backend's `signAttestation` has to reproduce the same literal.
 *
 * The attestor is Anvil's published dev account 0. A test vector printed in Foundry's own
 * documentation, funded on nothing, and never a Novi Corpus key.
 */
const GOLDEN_ATTESTOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

/** The fixed body both packages sign. Every signed field is also in
 *  `back/backend/test/hedera/attestation.test.ts`. */
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
  formation: { status: "complete", environment: "production" },
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

// The same literal is pinned in `back/backend/test/hedera/attestation.test.ts`: if either
// package's copy of the signed shape (the twelve typed fields) drifts, one of the two suites
// stops accepting it. The backend body also carries the unsigned `formation.filed` and
// `formation.einIssued`; this package's body type never had them.
const GOLDEN_SIGNATURE =
  "0x086d3f329535207f514a922585edf576587ead89b6c7b88c56d4e019ecd34a804f0aeb1df13fbc27f44d83578b7e837edb3faa7617aa428e3df4dc04d10f05e41b" as const;

describe("the golden vector", () => {
  it("accepts the body the backend signed", async () => {
    expect(await verifyAttestation(goldenBody(), GOLDEN_ATTESTOR, GOLDEN_SIGNATURE)).toBe(true);
  });

  it("rejects the same vector once standing is flipped", async () => {
    const tampered = { ...goldenBody(), standing: "inactive" as const };
    expect(await verifyAttestation(tampered, GOLDEN_ATTESTOR, GOLDEN_SIGNATURE)).toBe(false);
  });
});
