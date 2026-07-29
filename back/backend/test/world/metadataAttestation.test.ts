import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { EntityRecord } from "../../src/types";

const PUBLIC_ID = "22222222-2222-2222-2222-222222222222";
const KEY = "0xAAA:agent";
const TENANT = "0xAAA";
const NULLIFIER = "12345678901234567890";
const ACTION = "guardian-verification";

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let worldStore: SqliteWorldStore;

const rec: EntityRecord = {
  idempotencyKey: KEY,
  name: "A",
  status: "bound",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null,
  amendmentDelay: "0",
  ein: "",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: null,
  proxy: null,
  treasury: null,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  publicId: PUBLIC_ID,
  ownerTenantId: TENANT,
};

function app(withWorld: boolean) {
  const worldId = withWorld
    ? {
        cfg: {
          appId: "app_x",
          rpId: "rp_x",
          rpSigningKey: `0x${"1".repeat(64)}`,
          action: ACTION,
          environment: "staging" as const,
        },
        store: worldStore,
        maxEntitiesPerHuman: 3,
        requireGuardian: false,
      }
    : undefined;
  return buildApiApp({ webOrigin: "https://app.example.com", repo, docStore, worldId } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  worldStore = new SqliteWorldStore(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "meta-world-")));
  repo.upsert(rec);
  docStore.put(
    `meta-${KEY}.json`,
    JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY" } }),
  );
});
afterEach(() => db.close());

test("verified guardian -> metadata carries the worldId attestation", async () => {
  worldStore.recordVerification({
    nullifier: NULLIFIER,
    action: ACTION,
    tenantId: TENANT,
    issuerSchemaId: 1,
    credential: "proof_of_human",
    environment: "staging",
    verifiedAt: 1_700_000_000,
    expiresAtMin: null,
  });
  const body = (await (await app(true).request(`/metadata/${PUBLIC_ID}`)).json()) as {
    worldId?: { humanVerified: boolean; credential: string; humanRef: string; verifiedAt: number };
    name?: string;
  };
  expect(body.name).toBe("A"); // base metadata preserved
  expect(body.worldId?.humanVerified).toBe(true);
  expect(body.worldId?.credential).toBe("proof_of_human");
  expect(body.worldId?.verifiedAt).toBe(1_700_000_000);
});

test("PRIVACY: publishes sha256(nullifier), never the raw nullifier", async () => {
  worldStore.recordVerification({
    nullifier: NULLIFIER,
    action: ACTION,
    tenantId: TENANT,
    issuerSchemaId: 1,
    credential: "proof_of_human",
    environment: "staging",
    verifiedAt: 1_700_000_000,
    expiresAtMin: null,
  });
  const res = await app(true).request(`/metadata/${PUBLIC_ID}`);
  const raw = await res.text();
  expect(raw).not.toContain(NULLIFIER); // the identity datum never leaves our DB
  const body = JSON.parse(raw) as { worldId?: { humanRef: string } };
  expect(body.worldId?.humanRef).toBe(createHash("sha256").update(NULLIFIER).digest("hex"));
});

test("unverified tenant -> no worldId block", async () => {
  const body = (await (await app(true).request(`/metadata/${PUBLIC_ID}`)).json()) as {
    worldId?: unknown;
  };
  expect(body.worldId).toBeUndefined();
});

test("World not configured -> route behaves exactly as before", async () => {
  const body = (await (await app(false).request(`/metadata/${PUBLIC_ID}`)).json()) as {
    worldId?: unknown;
    name?: string;
  };
  expect(body.name).toBe("A");
  expect(body.worldId).toBeUndefined();
});
