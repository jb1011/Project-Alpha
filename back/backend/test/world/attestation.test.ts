import { hashSignal } from "@worldcoin/idkit-core";
import { describe, expect, test } from "vitest";
import { type WorldIdConfig, verifyAttestation } from "../../src/adapters/worldid/guardianGate";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

const CFG: WorldIdConfig = {
  appId: "app_x",
  rpId: "rp_x",
  rpSigningKey: `0x${"1".repeat(64)}`,
  action: "guardian-attest",
  environment: "staging",
};

/**
 * Shapes below are transcribed from a REAL staging round-trip captured by
 * scripts/world-attest-probe.mts (2026-07-25), not invented. The two load-bearing facts:
 *  - `identity_attested` is on the CLIENT payload; World's verify response never echoes it;
 *  - the verify response carries no attribute values at all, only results[].identifier.
 */
const IDKIT_RESULT = {
  action: "guardian-attest",
  environment: "staging",
  identity_attested: true,
  nonce: "abc",
  protocol_version: 4,
  user_presence_completed: true,
  responses: [
    {
      expires_at_min: 1785005211,
      identifier: "passport",
      issuer_schema_id: 9303,
      nullifier: "0x09e0a16069aa15d8773ae5ca0323e29a9262cf761dbaf1a499717480a30ae932",
      signal_hash: hashSignal("0xtenant"),
    },
  ],
};

const VERIFY_OK = {
  success: true,
  action: "guardian-attest",
  nullifier: "0x09e0a16069aa15d8773ae5ca0323e29a9262cf761dbaf1a499717480a30ae932",
  environment: "staging",
  results: [
    {
      identifier: "passport",
      success: true,
      nullifier: "0x09e0a16069aa15d8773ae5ca0323e29a9262cf761dbaf1a499717480a30ae932",
    },
  ],
  message: "Proof verified successfully",
};

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("verifyAttestation", () => {
  test("accepts a real-shaped attestation and normalises the nullifier to decimal", async () => {
    const a = await verifyAttestation(CFG, IDKIT_RESULT, 18, "0xtenant", fetchReturning(VERIFY_OK));
    expect(a.credential).toBe("passport");
    expect(a.minAge).toBe(18);
    expect(a.issuerSchemaId).toBe(9303); // ICAO 9303 — the passport standard
    expect(a.expiresAtMin).toBe(1785005211);
    expect(a.nullifier).toBe(BigInt(VERIFY_OK.nullifier).toString(10));
  });

  test("rejects a proof that carries no attestation flag", async () => {
    const noFlag = { ...IDKIT_RESULT, identity_attested: false };
    await expect(
      verifyAttestation(CFG, noFlag, 18, "0xtenant", fetchReturning(VERIFY_OK)),
    ).rejects.toThrow(/identity attestation/i);
  });

  test("a plain proof-of-human payload is not an attestation", async () => {
    const { identity_attested, ...bare } = IDKIT_RESULT;
    void identity_attested;
    await expect(
      verifyAttestation(CFG, bare, 18, "0xtenant", fetchReturning(VERIFY_OK)),
    ).rejects.toThrow();
  });

  test("rejects when World says the proof failed", async () => {
    const bad = { success: false, code: "invalid_proof", detail: "nope" };
    await expect(
      verifyAttestation(CFG, IDKIT_RESULT, 18, "0xtenant", fetchReturning(bad, 400)),
    ).rejects.toThrow(/invalid_proof|nope/);
  });

  test("rejects a device-tier credential even when attested", async () => {
    const weak = { ...VERIFY_OK, results: [{ identifier: "device", success: true }] };
    await expect(
      verifyAttestation(CFG, IDKIT_RESULT, 18, "0xtenant", fetchReturning(weak)),
    ).rejects.toThrow(/credential/i);
  });
});

describe("attestation store", () => {
  const base = {
    nullifier: "123",
    action: "guardian-attest",
    minAge: 18,
    credential: "passport",
    issuerSchemaId: 9303,
    verifiedAt: Date.now(),
    expiresAtMin: null,
  };

  test("records, reads back, and refuses a second tenant for the same human", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new SqliteWorldStore(db);

    expect(store.recordAttestation({ ...base, tenantId: "0xaaa" })).toBe(true);
    const found = store.findAttestationByTenant("0xaaa", "guardian-attest");
    expect(found?.minAge).toBe(18);
    expect(found?.credential).toBe("passport");

    // Same human, different account — the one-human-one-tenant rule, same as verifications.
    expect(store.recordAttestation({ ...base, tenantId: "0xbbb" })).toBe(false);
    // Re-attesting on the OWN account is fine (refresh, not a conflict).
    expect(store.recordAttestation({ ...base, tenantId: "0xaaa" })).toBe(true);
  });

  test("unattested tenant reads back nothing", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new SqliteWorldStore(db);
    expect(store.findAttestationByTenant("0xzzz", "guardian-attest")).toBeUndefined();
  });
});
