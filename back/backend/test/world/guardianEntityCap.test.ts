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
  /** UNIX SECONDS, as World actually sends it. */
  expiresAtMin?: number | null;
}): WorldIdDeps {
  return {
    cfg: { action: ACTION } as WorldIdDeps["cfg"],
    requireGuardian: opts.requireGuardian,
    attestMinAge: 18,
    maxEntitiesPerHuman: opts.maxEntitiesPerHuman,
    store: {
      findByTenant: () =>
        opts.verified
          ? { nullifier: NULLIFIER, expiresAtMin: opts.expiresAtMin ?? null }
          : undefined,
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

  // `expires_at_min` is UNIX SECONDS despite the name — our own captured fixture value
  // 1785005211 decodes to 2026-07-25, the day it was captured. Treating it as minutes puts
  // every credential in the year 5363, i.e. expiry could never fire.
  test("an EXPIRED credential no longer satisfies the gate", () => {
    const expired = Math.floor(Date.now() / 1000) - 60; // one minute ago, in seconds
    const d = deps({ requireGuardian: true, verified: true, used: 0, expiresAtMin: expired });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBe("guardian_credential_expired");
  });

  test("a live credential still satisfies the gate", () => {
    const live = Math.floor(Date.now() / 1000) + 3600;
    const d = deps({ requireGuardian: true, verified: true, used: 0, expiresAtMin: live });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBeNull();
  });

  test("a credential with no expiry is treated as live", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 0, expiresAtMin: null });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBeNull();
  });

  test("already past a ceiling lowered after the fact -> blocked", () => {
    const d = deps({ requireGuardian: true, verified: true, used: 6, maxEntitiesPerHuman: 3 });
    expect(codeOf(() => assertGuardianAllowed(d, TENANT))).toBe("guardian_entity_cap");
  });
});
