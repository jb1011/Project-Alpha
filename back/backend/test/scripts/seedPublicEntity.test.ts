// test/scripts/seedPublicEntity.test.ts — buildSeedRecord and assertDemoGuard from the demo-only
// seed script (task 6b). No network: buildSeedRecord is a pure mapping, and main() (the only
// piece that touches the network or a database) is never invoked here.
import { describe, expect, test } from "vitest";
import {
  type TransparencyEntity,
  assertDemoGuard,
  buildSeedRecord,
} from "../../scripts/demo/seed-public-entity.mjs";
import type { Address } from "../../src/types";

// FormationE2E_1's real public values (naming table D18; same fixture as test/helpers/hederaApp.ts).
const TRANSPARENCY: TransparencyEntity = {
  publicId: "9f8003f5-4c70-435a-9980-9a54625691b7",
  name: "FormationE2E_1",
  agentId: "886257",
};
const PROXY = "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE" as Address;
const TREASURY = "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf" as Address;
const MANAGER = "0x0000000000000000000000000000000000000001" as Address;
const GUARDIAN = "0x0000000000000000000000000000000000000002" as Address;
const TENANT = "0x000000000000000000000000000000000000000A" as Address;

describe("buildSeedRecord", () => {
  test("maps a transparency entry and addresses to a funded DEMO-LOCAL record with no key or party fields", () => {
    const rec = buildSeedRecord({
      transparency: TRANSPARENCY,
      proxy: PROXY,
      treasury: TREASURY,
      manager: MANAGER,
      guardian: GUARDIAN,
      tenant: TENANT,
    });

    expect(rec.status).toBe("funded");
    expect(rec.name).toBe("DEMO-LOCAL FormationE2E_1");
    expect(rec.ownerTenantId).toBe(TENANT);
    expect(rec.publicId).toBe(TRANSPARENCY.publicId);
    expect(rec.agentId).toBe(TRANSPARENCY.agentId);
    expect(rec.proxy).toBe(PROXY);
    expect(rec.treasury).toBe(TREASURY);
    expect(rec.manager).toBe(MANAGER);
    expect(rec.guardian).toBe(GUARDIAN);
    expect(rec.walletProvider).toBe("circle");

    // No key material and no party data anywhere on the row.
    expect(rec.turnkeySubOrgId ?? null).toBeNull();
    expect(rec.circleWalletSetId ?? null).toBeNull();
    expect(rec.pocketAddress ?? null).toBeNull();
    expect(rec.specJson ?? null).toBeNull();
  });
});

describe("assertDemoGuard", () => {
  test("throws when HEDERA_DEMO_LOCAL is not set", () => {
    expect(() => assertDemoGuard({ HEDERA_DEMO_LOCAL: undefined, NODE_ENV: "test" })).toThrow(
      "DEMO ONLY: set HEDERA_DEMO_LOCAL=1 to run this script",
    );
  });

  test("throws when NODE_ENV is production even with the guard set", () => {
    expect(() => assertDemoGuard({ HEDERA_DEMO_LOCAL: "1", NODE_ENV: "production" })).toThrow(
      "DEMO ONLY: refuses to run with NODE_ENV=production",
    );
  });
});
