import { hashSignal } from "@worldcoin/idkit-core";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { WorldIdError, verifyProof } from "../../src/adapters/worldid/guardianGate";
import { migrate } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

const CFG = {
  appId: "app_test",
  rpId: "rp_test",
  rpSigningKey: `0x${"1".repeat(64)}`,
  action: "guardian-verification",
  environment: "staging" as const,
};

function db() {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}

/** Minimal fetch stub returning a canned verify response. */
function fetchStub(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("verifyProof — credential tier + nullifier normalization", () => {
  const SIGNAL = "0xtenant";
  // Every real payload carries the signal it was minted for; these fixtures must too, or they
  // would be asserting behaviour that can no longer occur in production.
  const idkitResult = {
    responses: [{ issuer_schema_id: 1, expires_at_min: 999, signal_hash: hashSignal(SIGNAL) }],
  };

  test("accepts proof_of_human and normalizes the nullifier to decimal", async () => {
    const v = await verifyProof(
      CFG,
      idkitResult,
      SIGNAL,
      fetchStub(200, {
        success: true,
        environment: "staging",
        results: [{ identifier: "proof_of_human", success: true, nullifier: "0x1f" }],
      }),
    );
    expect(v.nullifier).toBe("31"); // 0x1f -> decimal, so hex casing can't defeat dedupe
    expect(v.credential).toBe("proof_of_human");
    expect(v.issuerSchemaId).toBe(1);
  });

  test("accepts legacy orb", async () => {
    const v = await verifyProof(
      CFG,
      idkitResult,
      SIGNAL,
      fetchStub(200, {
        success: true,
        results: [{ identifier: "orb", success: true, nullifier: "42" }],
      }),
    );
    expect(v.credential).toBe("orb");
    expect(v.nullifier).toBe("42");
  });

  test("REJECTS device tier (insufficient for guardianship)", async () => {
    await expect(
      verifyProof(
        CFG,
        idkitResult,
        SIGNAL,
        fetchStub(200, {
          success: true,
          results: [{ identifier: "device", success: true, nullifier: "7" }],
        }),
      ),
    ).rejects.toThrow(/credential/i);
  });

  test("REJECTS selfie tier", async () => {
    await expect(
      verifyProof(
        CFG,
        idkitResult,
        SIGNAL,
        fetchStub(200, {
          success: true,
          results: [{ identifier: "selfie", success: true, nullifier: "7" }],
        }),
      ),
    ).rejects.toThrow(WorldIdError);
  });

  test("propagates portal failure (400)", async () => {
    await expect(
      verifyProof(
        CFG,
        idkitResult,
        SIGNAL,
        fetchStub(400, { success: false, code: "invalid_proof", detail: "bad" }),
      ),
    ).rejects.toThrow(/invalid_proof|bad/);
  });

  test("ignores failed sub-results", async () => {
    await expect(
      verifyProof(
        CFG,
        idkitResult,
        SIGNAL,
        fetchStub(200, {
          success: true,
          results: [{ identifier: "proof_of_human", success: false, code: "verification_error" }],
        }),
      ),
    ).rejects.toThrow(/credential/i);
  });
});

describe("verifyProof — the proof must be bound to THIS tenant and THIS action", () => {
  const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ok = (nullifier = "0x1f") => ({
    success: true,
    action: CFG.action,
    results: [{ identifier: "proof_of_human", success: true, nullifier }],
  });
  const payloadFor = (signal: string) => ({
    responses: [{ issuer_schema_id: 1, expires_at_min: 999, signal_hash: hashSignal(signal) }],
  });

  test("accepts a proof whose signal is this tenant", async () => {
    const v = await verifyProof(CFG, payloadFor(TENANT), TENANT, fetchStub(200, ok()));
    expect(v.nullifier).toBe("31");
  });

  // The sybil bypass: a proof minted for someone else's tenant must not verify mine.
  test("REFUSES a proof minted for a different tenant (replay)", async () => {
    await expect(verifyProof(CFG, payloadFor(OTHER), TENANT, fetchStub(200, ok()))).rejects.toThrow(
      /signal/i,
    );
  });

  test("REFUSES a proof carrying no signal at all", async () => {
    const bare = { responses: [{ issuer_schema_id: 1, expires_at_min: 999 }] };
    await expect(verifyProof(CFG, bare, TENANT, fetchStub(200, ok()))).rejects.toThrow(/signal/i);
  });

  // Cross-action swap: a proof for another action yields a DIFFERENT nullifier for the same
  // human, so accepting it would let one person hold two guardianships.
  test("REFUSES a proof issued for a different action", async () => {
    const other = { ...ok(), action: "guardian-attest" };
    await expect(
      verifyProof(CFG, payloadFor(TENANT), TENANT, fetchStub(200, other)),
    ).rejects.toThrow(/action/i);
  });

  test("accepts when World omits the action (older responses stay compatible)", async () => {
    // JSON.stringify drops undefined keys, so the stubbed response has no `action` at all.
    const noAction = { ...ok(), action: undefined };
    const v = await verifyProof(CFG, payloadFor(TENANT), TENANT, fetchStub(200, noAction));
    expect(v.credential).toBe("proof_of_human");
  });
});

describe("WorldStore — sybil gate + allowance", () => {
  const base = {
    action: "guardian-verification",
    issuerSchemaId: 1,
    credential: "proof_of_human",
    environment: "staging",
    verifiedAt: 1_700_000_000,
    expiresAtMin: null,
  };

  test("same human cannot bind to a second tenant", () => {
    const s = new SqliteWorldStore(db());
    expect(s.recordVerification({ ...base, nullifier: "555", tenantId: "0xAAA" })).toBe(true);
    // Different tenant, same human -> refused (this is the sybil gate).
    expect(s.recordVerification({ ...base, nullifier: "555", tenantId: "0xBBB" })).toBe(false);
    expect(s.findByNullifier("555", base.action)?.tenantId).toBe("0xAAA");
  });

  test("same human + same tenant re-verify is idempotent", () => {
    const s = new SqliteWorldStore(db());
    expect(s.recordVerification({ ...base, nullifier: "555", tenantId: "0xAAA" })).toBe(true);
    expect(
      s.recordVerification({
        ...base,
        nullifier: "555",
        tenantId: "0xAAA",
        verifiedAt: 1_700_000_100,
      }),
    ).toBe(true);
    expect(s.findByTenant("0xAAA", base.action)?.verifiedAt).toBe(1_700_000_100);
  });

  test("entity count for a human starts at zero", () => {
    const s = new SqliteWorldStore(db());
    s.recordVerification({ ...base, nullifier: "555", tenantId: "0xAAA" });
    expect(s.countEntitiesForNullifier("555", base.action)).toBe(0);
  });

  test("nonce is single-use (agentkit replay guard)", () => {
    const s = new SqliteWorldStore(db());
    expect(s.consumeNonce("n1", 1)).toBe(true);
    expect(s.consumeNonce("n1", 2)).toBe(false);
  });

  test("authorization allowance increments then refuses past the limit", () => {
    const s = new SqliteWorldStore(db());
    const r = () => s.tryIncrementUsage("human1", "/x402-demo/quote", 2, 1);
    expect(r()).toEqual({ allowed: true, used: 1 });
    expect(r()).toEqual({ allowed: true, used: 2 });
    expect(r()).toEqual({ allowed: false, used: 2 }); // beyond allowance -> falls through to payment
  });

  test("human cache respects TTL", () => {
    const s = new SqliteWorldStore(db());
    s.cacheHuman("0xAbC", "human1", 1_000);
    expect(s.getCachedHuman("0xabc", 1_500, 1_000)).toBe("human1"); // case-insensitive
    expect(s.getCachedHuman("0xabc", 5_000, 1_000)).toBeUndefined(); // expired -> re-read
  });
});
