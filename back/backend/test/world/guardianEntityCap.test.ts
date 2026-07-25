import { describe, expect, test } from "vitest";
import { ApiError } from "../../src/api/errors";
import { type WorldIdDeps, assertGuardianAllowed } from "../../src/api/routes/worldId";

const ACTION = "guardian";
const TENANT = "0xabc";
const NULLIFIER = "12345";

/** Only the two reads the gate performs. */
function deps(opts: {
  requireGuardian: boolean;
  verified: boolean;
  used: number;
  maxEntitiesPerHuman?: number;
}): WorldIdDeps {
  return {
    cfg: { action: ACTION } as WorldIdDeps["cfg"],
    requireGuardian: opts.requireGuardian,
    maxEntitiesPerHuman: opts.maxEntitiesPerHuman,
    store: {
      findByTenant: () => (opts.verified ? { nullifier: NULLIFIER } : undefined),
      countEntitiesForNullifier: () => opts.used,
    } as unknown as WorldIdDeps["store"],
  };
}

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.code : `unexpected:${String(e)}`;
  }
}

describe("assertGuardianAllowed", () => {
  test("no-op when World isn't configured", () => {
    expect(codeOf(() => assertGuardianAllowed(undefined, TENANT))).toBeNull();
  });

  test("no-op when enforcement is off, even with no verification", () => {
    const d = deps({ requireGuardian: false, verified: false, used: 99 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBeNull();
  });

  test("blocks an unverified guardian when enforcement is on", () => {
    const d = deps({ requireGuardian: true, verified: false, used: 0 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBe("guardian_not_verified");
  });

  test("no ceiling configured -> a verified human may form any number of entities", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 500 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBeNull();
  });

  test("under a configured ceiling -> allowed", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 2, maxEntitiesPerHuman: 3 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBeNull();
  });

  test("at a configured ceiling -> blocked", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 3, maxEntitiesPerHuman: 3 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBe("guardian_entity_cap");
  });

  test("already past a ceiling lowered after the fact -> blocked", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 6, maxEntitiesPerHuman: 3 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBe("guardian_entity_cap");
  });
});
