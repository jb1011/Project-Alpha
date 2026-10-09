/**
 * The real-human state, without a throw.
 *
 * `realHumanState` makes the checks of `assertRealHuman`, in the same order, and answers which one
 * failed instead of throwing: for a reader that states whether a guardian is a verified human
 * rather than refusing anything. `assertRealHuman` turns each answer into the refusal it has
 * always thrown, and the parity table below holds the two together over every World
 * configuration, kind of verification row and deployment environment.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCEPTED_CREDENTIALS, type WorldIdConfig } from "../../src/adapters/worldid/guardianGate";
import { ApiError } from "../../src/api/errors";
import {
  type RealHumanState,
  type WorldIdDeps,
  assertRealHuman,
  buildWorldIdDeps,
  realHumanState,
} from "../../src/api/routes/worldId";
import { migrate, openDatabase } from "../../src/persistence/db";
import { type GuardianVerification, SqliteWorldStore } from "../../src/persistence/worldStore";

const ACTION = "guardian-verification";
const ENVIRONMENTS = ["sandbox", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];
type Reason = Extract<RealHumanState, { ok: false }>["reason"];
type Refusal = { code: string; status: number; message: string };

/** The refusal `assertRealHuman` throws for each reason: the code, status and message it has
 *  always thrown for that check, written out here as the doors answer them. */
const REFUSAL: Record<Reason, Refusal> = {
  unavailable: {
    code: "unavailable",
    status: 503,
    message: "human verification is not configured on this deployment",
  },
  not_production: {
    code: "unavailable",
    status: 503,
    message: "human verification on this deployment is not configured for production",
  },
  not_verified: {
    code: "guardian_not_verified",
    status: 403,
    message: "the guardian must complete World ID verification first",
  },
  waiver: {
    code: "waiver_not_accepted",
    status: 403,
    message:
      "a waiver, or a credential below the accepted tiers, does not count as a verified human here",
  },
  row_not_production: {
    code: "guardian_not_verified",
    status: 403,
    message: "the guardian's World ID verification was not made under production: verify again",
  },
};

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
    environment?: WorldIdConfig["environment"];
    requireGuardian?: boolean;
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

/** A tenant of its own for each row (the table holds one row per human), checksummed like the
 *  session's tenant. */
const tenantOf = (i: number) => getAddress(`0x${(0xd0 + i).toString(16).padStart(40, "0")}`);

/** A verification row for `tenantId`, recorded as the verify route records one. */
function verified(
  tenantId: string,
  credential: string | null,
  over: Partial<GuardianVerification> = {},
): GuardianVerification {
  const row: GuardianVerification = {
    nullifier: BigInt(tenantId).toString(),
    action: ACTION,
    tenantId,
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

/** A redeemed waiver, recorded as the waiver route records one: no schema and no environment. */
function waived(tenantId: string): GuardianVerification {
  const codeHash = createHash("sha256").update(`example-waiver-code-${tenantId}`).digest("hex");
  return verified(tenantId, "waiver", {
    nullifier: `waiver:${codeHash}`,
    issuerSchemaId: null,
    environment: null,
  });
}

/** What `assertRealHuman` does: the row it returns, or the refusal it throws. */
function asserted(
  w: WorldIdDeps | undefined,
  tenantId: string,
  environment: Environment,
): { returned: GuardianVerification } | { refused: Refusal } {
  try {
    return { returned: assertRealHuman(w, tenantId, environment) };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { refused: { code: err.code, status: err.status, message: err.message } };
  }
}

describe("realHumanState", () => {
  test("a verified human is ok, with the row itself, on both environments", () => {
    const row = verified(tenantOf(1), "proof_of_human");
    for (const environment of ENVIRONMENTS)
      expect(realHumanState(world(), tenantOf(1), environment), environment).toStrictEqual({
        ok: true,
        verification: row,
      });
  });

  test("every credential the verification path accepts is ok: the rule reads that path's own set", () => {
    expect(ACCEPTED_CREDENTIALS.size).toBeGreaterThan(0);
    expect(ACCEPTED_CREDENTIALS.has("waiver")).toBe(false);
    [...ACCEPTED_CREDENTIALS].forEach((credential, i) => {
      const tenantId = tenantOf(0x10 + i);
      const row = verified(tenantId, credential);
      expect(realHumanState(world(), tenantId, "production"), credential).toStrictEqual({
        ok: true,
        verification: row,
      });
    });
  });

  test("unavailable: a deployment without World ID, on both environments", () => {
    for (const environment of ENVIRONMENTS)
      expect(realHumanState(undefined, tenantOf(1), environment), environment).toStrictEqual({
        ok: false,
        reason: "unavailable",
      });
  });

  test("not_production: on production, a World configuration that is not production, whatever the row", () => {
    verified(tenantOf(1), "proof_of_human");
    waived(tenantOf(2));
    for (const environment of ["staging", "sandbox"] as const) {
      // The configuration is checked before the row: a verified human, a waiver and a tenant with
      // no row at all get the same answer.
      for (const tenantId of [tenantOf(1), tenantOf(2), tenantOf(3)])
        expect(
          realHumanState(world({ environment }), tenantId, "production"),
          `${environment}, ${tenantId}`,
        ).toStrictEqual({ ok: false, reason: "not_production" });
      // A sandbox deployment may rest on a World configuration that is not production.
      expect(realHumanState(world({ environment }), tenantOf(1), "sandbox").ok, environment).toBe(
        true,
      );
    }
  });

  test("not_verified: no verification row for the guardian action, on both environments", () => {
    // A verification for another action does not count.
    verified(tenantOf(2), "proof_of_human", { action: "identity-attestation" });
    for (const environment of ENVIRONMENTS)
      for (const tenantId of [tenantOf(1), tenantOf(2)])
        expect(
          realHumanState(world(), tenantId, environment),
          `${environment}, ${tenantId}`,
        ).toStrictEqual({ ok: false, reason: "not_verified" });
  });

  test("waiver: a waiver, a row with no credential, or a credential below the accepted tiers, on both environments", () => {
    waived(tenantOf(1));
    verified(tenantOf(2), null);
    // The credential is checked before the row's environment: the waiver's row records no
    // environment and this one was made under staging, and on production both still read waiver.
    verified(tenantOf(3), "device", { environment: "staging" });
    for (const environment of ENVIRONMENTS)
      for (const tenantId of [tenantOf(1), tenantOf(2), tenantOf(3)])
        expect(
          realHumanState(world(), tenantId, environment),
          `${environment}, ${tenantId}`,
        ).toStrictEqual({ ok: false, reason: "waiver" });
  });

  test("row_not_production: on production, a row made under staging, sandbox or no environment; a sandbox deployment accepts it", () => {
    const recordedUnder = ["staging", "sandbox", null] as const;
    recordedUnder.forEach((environment, i) => {
      const row = verified(tenantOf(i), "orb", { environment });
      expect(realHumanState(world(), tenantOf(i), "production"), String(environment)).toStrictEqual(
        { ok: false, reason: "row_not_production" },
      );
      expect(realHumanState(world(), tenantOf(i), "sandbox"), String(environment)).toStrictEqual({
        ok: true,
        verification: row,
      });
    });
  });

  test("it ignores requireGuardian and applies no cap, as assertRealHuman does", () => {
    const row = verified(tenantOf(1), "passport");
    const relaxed = world({
      requireGuardian: false,
      maxCompaniesPerHuman: 0,
      maxEntitiesPerHuman: 0,
    });
    expect(realHumanState(relaxed, tenantOf(1), "production")).toStrictEqual({
      ok: true,
      verification: row,
    });
    expect(realHumanState(relaxed, tenantOf(2), "production")).toStrictEqual({
      ok: false,
      reason: "not_verified",
    });
  });
});

describe("assertRealHuman answers what realHumanState states", () => {
  /** The World configurations of the table: none, then each environment World can be set to. */
  const CONFIGS: (WorldIdConfig["environment"] | undefined)[] = [
    undefined,
    "production",
    "staging",
    "sandbox",
  ];

  /** One kind of row per tenant, with the answer for it under a production World configuration,
   *  on each deployment environment. */
  const TENANTS: {
    label: string;
    record: (tenantId: string) => void;
    answer: Record<Environment, Reason | "ok">;
  }[] = [
    {
      label: "verified under production",
      record: (t) => verified(t, "proof_of_human"),
      answer: { production: "ok", sandbox: "ok" },
    },
    {
      label: "a waiver",
      record: (t) => waived(t),
      answer: { production: "waiver", sandbox: "waiver" },
    },
    {
      label: "no credential",
      record: (t) => verified(t, null),
      answer: { production: "waiver", sandbox: "waiver" },
    },
    {
      label: "a credential below the accepted tiers",
      record: (t) => verified(t, "device"),
      answer: { production: "waiver", sandbox: "waiver" },
    },
    {
      label: "verified under staging",
      record: (t) => verified(t, "orb", { environment: "staging" }),
      answer: { production: "row_not_production", sandbox: "ok" },
    },
    {
      label: "verified under no environment",
      record: (t) => verified(t, "passport", { environment: null }),
      answer: { production: "row_not_production", sandbox: "ok" },
    },
    {
      label: "no row",
      record: () => {},
      answer: { production: "not_verified", sandbox: "not_verified" },
    },
  ];

  /** The expected answer: no World is unavailable; on production, a World configuration that is
   *  not production is not_production; otherwise the row decides. */
  function expectedOf(
    config: WorldIdConfig["environment"] | undefined,
    tenant: (typeof TENANTS)[number],
    environment: Environment,
  ): Reason | "ok" {
    if (config === undefined) return "unavailable";
    if (environment === "production" && config !== "production") return "not_production";
    return tenant.answer[environment];
  }

  test("over 56 fixtures, it throws exactly when the state is not ok, with the mapped code, status and message, and otherwise returns the state's row", () => {
    TENANTS.forEach((tenant, i) => tenant.record(tenantOf(i)));
    const seen = new Set<Reason | "ok">();
    let fixtures = 0;
    for (const config of CONFIGS) {
      const w = config === undefined ? undefined : world({ environment: config });
      TENANTS.forEach((tenant, i) => {
        for (const environment of ENVIRONMENTS) {
          const name = `World ${config ?? "absent"}, ${tenant.label}, ${environment} deployment`;
          // Called outside any try: it answers every fixture without a throw.
          const state = realHumanState(w, tenantOf(i), environment);
          const outcome = state.ok ? "ok" : state.reason;
          expect(outcome, name).toBe(expectedOf(config, tenant, environment));
          const result = asserted(w, tenantOf(i), environment);
          if (state.ok) expect(result, name).toStrictEqual({ returned: state.verification });
          else expect(result, name).toStrictEqual({ refused: REFUSAL[state.reason] });
          seen.add(outcome);
          fixtures += 1;
        }
      });
    }
    expect(fixtures).toBe(56);
    // The table reaches every reason, and a pass.
    expect([...seen].sort()).toEqual([
      "not_production",
      "not_verified",
      "ok",
      "row_not_production",
      "unavailable",
      "waiver",
    ]);
  });
});
