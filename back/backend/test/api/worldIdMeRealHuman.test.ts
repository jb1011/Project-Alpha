import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCEPTED_CREDENTIALS, type WorldIdConfig } from "../../src/adapters/worldid/guardianGate";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { type WorldIdDeps, buildWorldIdDeps } from "../../src/api/routes/worldId";
import { signSession } from "../../src/auth/session";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { GuardianVerification } from "../../src/persistence/worldStore";
import { customerCompanyDeps } from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  type Json,
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/**
 * `GET /world-id/me` says whether the legal-body doors' real-human gate accepts the tenant's World
 * ID row, so the browser can tell before it spends a door. The answer is the gate's own predicate,
 * on the environment of whichever of those doors the deployment mounts; where neither is mounted
 * the key is absent and the answer is the one it always was.
 */

const ACTION = "guardian-verification";
const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
// The session's tenant is a checksummed address, and so is every row the routes write.
const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
const ENVIRONMENTS = ["sandbox", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

let db: Database.Database;
let s: LegalBodyStores;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
});
afterEach(() => db.close());

/** World ID wired the way the API wires it, through its one builder. */
function world(
  opts: {
    requireGuardian?: boolean;
    environment?: WorldIdConfig["environment"];
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
      maxEntitiesPerHuman: opts.maxEntitiesPerHuman,
      requireGuardian: opts.requireGuardian ?? true,
    },
    s.store,
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
  expect(s.store.recordVerification(row)).toBe(true);
  return row;
}

/** A redeemed waiver, recorded exactly as the waiver route records one. */
function waived(tenantId: Address = TENANT): GuardianVerification {
  const codeHash = createHash("sha256").update(`example-waiver-code-${tenantId}`).digest("hex");
  return verified("waiver", {
    tenantId,
    nullifier: `waiver:${codeHash}`,
    issuerSchemaId: null,
    environment: null,
  });
}

/** The legal-body doors a deployment mounts, each on its environment. */
type Doors = { legalBodyOrders?: Environment; customerCompanies?: Environment };
type Door = keyof Doors;

/** The API over this test's database, with World ID and whichever doors `doors` names. Each door
 *  rests on the same World ID object as the World ID routes, as the composition root wires it. */
function makeApp(w: WorldIdDeps, doors: Doors = {}) {
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new DeletableMemoryDocumentStore();
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo: new SqliteEntityRepository(db),
    docStore,
    worldId: w,
    legalBodyOrders:
      doors.legalBodyOrders === undefined
        ? undefined
        : legalBodyOrderDeps(s, { world: w, environment: doors.legalBodyOrders }),
    customerCompanies:
      doors.customerCompanies === undefined
        ? undefined
        : {
            ...customerCompanyDeps(s, Date.now, {
              world: w,
              environment: doors.customerCompanies,
            }),
            documents,
            docStore,
          },
  };
  return buildApiApp(deps as ApiDeps);
}

/** The tenant's `GET /world-id/me` answer. */
async function me(app: ReturnType<typeof makeApp>, tenantId: Address = TENANT): Promise<Json> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  const res = await app.request("/world-id/me", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return res.json();
}

/** The answer without `realHuman`. */
function withoutRealHuman(answer: Json): Json {
  const { realHuman: _realHuman, ...rest } = answer;
  return rest;
}

describe.each(["legalBodyOrders", "customerCompanies"] as const)(
  "GET /world-id/me with only %s mounted",
  (door: Door) => {
    const only = (environment: Environment): Doors => ({ [door]: environment });

    test("every credential the gate accepts, on a sandbox deployment, answers realHuman: true", async () => {
      // A sandbox deployment rests on a World configuration and a row that are not production.
      const w = world({ environment: "staging" });
      const app = makeApp(w, only("sandbox"));
      let i = 0;
      for (const credential of ACCEPTED_CREDENTIALS) {
        const tenantId = getAddress(`0x${(0xb0 + i).toString(16).padStart(40, "0")}`);
        verified(credential, { tenantId, nullifier: String(2001 + i), environment: "staging" });
        const answer = await me(app, tenantId);
        expect(answer, credential).toMatchObject({ verified: true, credential, realHuman: true });
        i += 1;
      }
      expect(i).toBeGreaterThan(0);
    });

    test("a waiver answers realHuman: false, still verified: true with credential waiver", async () => {
      waived();
      for (const environment of ENVIRONMENTS)
        expect(await me(makeApp(world(), only(environment))), environment).toMatchObject({
          verified: true,
          credential: "waiver",
          realHuman: false,
        });
    });

    test("no row answers verified: false and realHuman: false", async () => {
      for (const environment of ENVIRONMENTS) {
        const answer = await me(makeApp(world(), only(environment)));
        expect(answer.verified, environment).toBe(false);
        expect(answer.realHuman, environment).toBe(false);
      }
    });

    test("on production a World configured for staging answers false, and so does a staging row", async () => {
      // A real credential recorded under production: only the World configuration is staging.
      verified("proof_of_human");
      expect(
        (await me(makeApp(world({ environment: "staging" }), only("production")))).realHuman,
      ).toBe(false);

      // A real credential recorded under staging, under a World configured for production now.
      const stagingTenant = getAddress("0x00000000000000000000000000000000000000c1");
      verified("proof_of_human", {
        tenantId: stagingTenant,
        nullifier: "3001",
        environment: "staging",
      });
      const app = makeApp(world(), only("production"));
      expect((await me(app, stagingTenant)).realHuman).toBe(false);

      // Both production: the same production deployment answers true.
      expect((await me(app)).realHuman).toBe(true);
      // And a sandbox deployment accepts the staging row.
      expect((await me(makeApp(world(), only("sandbox")), stagingTenant)).realHuman).toBe(true);
    });
  },
);

describe("GET /world-id/me with neither legal-body door mounted", () => {
  test("the answer carries no realHuman and is the answer it always was", async () => {
    const w = world({ maxEntitiesPerHuman: 3 });
    const app = makeApp(w);

    const unverified = await me(app);
    expect(unverified).not.toHaveProperty("realHuman");
    expect(unverified).toEqual({
      verified: false,
      required: w.requireGuardian,
      attestAvailable: false,
    });

    const row = verified("proof_of_human");
    const answer = await me(app);
    expect(answer).not.toHaveProperty("realHuman");
    expect(answer).toEqual({
      verified: true,
      required: w.requireGuardian,
      credential: row.credential,
      verifiedAt: row.verifiedAt,
      nullifier: row.nullifier,
      entitiesUsed: 0,
      maxEntities: w.maxEntitiesPerHuman,
      attestAvailable: false,
      formationReady: false,
    });
  });

  test("mounting a door adds realHuman and changes no other key", async () => {
    const w = world({ maxEntitiesPerHuman: 3 });
    const NO_ROW = getAddress("0x00000000000000000000000000000000000000d1");
    const WAIVED = getAddress("0x00000000000000000000000000000000000000d2");
    verified("proof_of_human");
    waived(WAIVED);

    const arrangements: Doors[] = [
      { legalBodyOrders: "sandbox" },
      { legalBodyOrders: "production" },
      { customerCompanies: "sandbox" },
      { customerCompanies: "production" },
      { legalBodyOrders: "production", customerCompanies: "production" },
    ];
    for (const tenantId of [TENANT, NO_ROW, WAIVED]) {
      const before = await me(makeApp(w), tenantId);
      for (const doors of arrangements) {
        const after = await me(makeApp(w, doors), tenantId);
        const label = `${tenantId} ${JSON.stringify(doors)}`;
        expect(typeof after.realHuman, label).toBe("boolean");
        expect(withoutRealHuman(after), label).toEqual(before);
      }
    }
  });
});
