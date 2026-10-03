import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCEPTED_CREDENTIALS, type WorldIdConfig } from "../../src/adapters/worldid/guardianGate";
import { ApiError } from "../../src/api/errors";
import { type WorldIdDeps, assertRealHuman, buildWorldIdDeps } from "../../src/api/routes/worldId";
import { migrate, openDatabase } from "../../src/persistence/db";
import { type GuardianVerification, SqliteWorldStore } from "../../src/persistence/worldStore";

const ACTION = "guardian-verification";
// The session's tenant is a checksummed address, and so is every row the routes write.
const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
const ENVIRONMENTS = ["sandbox", "production"] as const;

let db: Database.Database;
let store: SqliteWorldStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});
afterEach(() => db.close());

/** World ID wired the way the API wires it, through its one builder. */
function world(
  opts: {
    requireGuardian?: boolean;
    environment?: WorldIdConfig["environment"];
    maxCompaniesPerHuman?: number;
    maxEntitiesPerHuman?: number;
  } = {},
): WorldIdDeps {
  return buildWorldIdDeps(
    {
      appId: "app_test",
      rpId: "rp_test",
      rpSigningKey: `0x${"1".repeat(64)}`,
      action: ACTION,
      environment: opts.environment ?? "production",
      attestMinAge: 18,
      maxCompaniesPerHuman: opts.maxCompaniesPerHuman,
      maxEntitiesPerHuman: opts.maxEntitiesPerHuman,
      requireGuardian: opts.requireGuardian ?? true,
    },
    store,
  );
}

/** A verification row as the verify route records it. */
function verified(
  credential: string | null,
  over: Partial<GuardianVerification> = {},
): GuardianVerification {
  const row: GuardianVerification = {
    nullifier: "1001",
    action: ACTION,
    tenantId: TENANT,
    issuerSchemaId: 1,
    credential,
    environment: "production",
    verifiedAt: 1_790_000_000_000,
    expiresAtMin: null,
    ...over,
  };
  expect(store.recordVerification(row)).toBe(true);
  return row;
}

/** A redeemed waiver, recorded exactly as the waiver route records one. */
function waived(): void {
  const codeHash = createHash("sha256").update("example-waiver-code").digest("hex");
  verified("waiver", { nullifier: `waiver:${codeHash}`, issuerSchemaId: null, environment: null });
}

/** The refusal's code and status, or null when the call passes. */
function refusal(call: () => unknown): { code: string; status: number } | null {
  try {
    call();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return { code: err.code, status: err.status };
    throw err;
  }
}

describe("assertRealHuman", () => {
  test("a real verification passes and is returned, with requireGuardian off and on", () => {
    const row = verified("proof_of_human");
    for (const requireGuardian of [false, true])
      for (const environment of ENVIRONMENTS)
        expect(assertRealHuman(world({ requireGuardian }), TENANT, environment)).toEqual(row);
  });

  test("every credential the verification path accepts passes: the rule reads that path's own set", () => {
    expect(ACCEPTED_CREDENTIALS.size).toBeGreaterThan(0);
    expect(ACCEPTED_CREDENTIALS.has("waiver")).toBe(false);
    [...ACCEPTED_CREDENTIALS].forEach((credential, i) => {
      const tenantId = getAddress(`0x${(0xb0 + i).toString(16).padStart(40, "0")}`);
      verified(credential, { tenantId, nullifier: String(2001 + i) });
      expect(assertRealHuman(world(), tenantId, "production").credential).toBe(credential);
    });
  });

  test("a waiver is refused, with requireGuardian off and on", () => {
    waived();
    for (const requireGuardian of [false, true])
      for (const environment of ENVIRONMENTS)
        expect(
          refusal(() => assertRealHuman(world({ requireGuardian }), TENANT, environment)),
        ).toEqual({ code: "waiver_not_accepted", status: 403 });
  });

  test("a verification with no credential is refused, with requireGuardian off and on", () => {
    verified(null);
    for (const requireGuardian of [false, true])
      for (const environment of ENVIRONMENTS)
        expect(
          refusal(() => assertRealHuman(world({ requireGuardian }), TENANT, environment)),
        ).toEqual({ code: "waiver_not_accepted", status: 403 });
  });

  test("a credential outside the accepted tiers is refused", () => {
    verified("device");
    expect(refusal(() => assertRealHuman(world(), TENANT, "production"))).toEqual({
      code: "waiver_not_accepted",
      status: 403,
    });
  });

  test("a tenant with no verification row is refused, with requireGuardian off and on", () => {
    for (const requireGuardian of [false, true])
      for (const environment of ENVIRONMENTS)
        expect(
          refusal(() => assertRealHuman(world({ requireGuardian }), TENANT, environment)),
        ).toEqual({ code: "guardian_not_verified", status: 403 });
  });

  test("only a verification for the guardian action counts", () => {
    verified("proof_of_human", { action: "identity-attestation" });
    expect(refusal(() => assertRealHuman(world(), TENANT, "production"))).toEqual({
      code: "guardian_not_verified",
      status: 403,
    });
  });

  test("a deployment without World ID is a 503 on both environments", () => {
    for (const environment of ENVIRONMENTS)
      expect(refusal(() => assertRealHuman(undefined, TENANT, environment))).toEqual({
        code: "unavailable",
        status: 503,
      });
  });

  test("on production a World configuration that is not production is a 503, even for a verified human", () => {
    verified("proof_of_human");
    for (const environment of ["staging", "sandbox"] as const) {
      expect(refusal(() => assertRealHuman(world({ environment }), TENANT, "production"))).toEqual({
        code: "unavailable",
        status: 503,
      });
      // A sandbox deployment may use a World configuration that is not production.
      expect(refusal(() => assertRealHuman(world({ environment }), TENANT, "sandbox"))).toBeNull();
    }
    expect(refusal(() => assertRealHuman(world(), TENANT, "production"))).toBeNull();
  });

  test("it applies no cap: the callers do", () => {
    verified("orb");
    const capped = world({ maxCompaniesPerHuman: 0, maxEntitiesPerHuman: 0 });
    expect(refusal(() => assertRealHuman(capped, TENANT, "production"))).toBeNull();
  });
});
