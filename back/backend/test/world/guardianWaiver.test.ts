import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { assertGuardianAllowed } from "../../src/api/routes/worldId";
import { signSession } from "../../src/auth/session";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { EntityRecord } from "../../src/types";

const ACTION = "guardian-verification";
// requireAuth sets the CHECKSUMMED address as tenantId, so store rows written by routes carry
// this exact casing — fixtures must match or lookups silently miss.
const TENANT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const OTHER = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const JWT_SECRET = "s";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

let db: Database.Database;
let store: SqliteWorldStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteWorldStore(db);
});
afterEach(() => db.close());

describe("WorldStore — guardian waivers", () => {
  test("a waiver redeems exactly once", () => {
    store.createWaiver({ codeHash: hash("c1"), note: "colleague", createdAt: 1_000 });
    expect(store.redeemWaiver(hash("c1"), TENANT, 2_000)).toEqual({ note: "colleague" });
    // Single-use: the second redemption fails even for the same tenant.
    expect(store.redeemWaiver(hash("c1"), TENANT, 3_000)).toBeUndefined();
    expect(store.redeemWaiver(hash("c1"), OTHER, 3_000)).toBeUndefined();
  });

  test("an unknown code does not redeem", () => {
    expect(store.redeemWaiver(hash("nope"), TENANT, 1_000)).toBeUndefined();
  });

  test("an expired waiver does not redeem", () => {
    store.createWaiver({ codeHash: hash("c2"), note: "x", createdAt: 1_000, expiresAt: 2_000 });
    expect(store.redeemWaiver(hash("c2"), TENANT, 2_001)).toBeUndefined();
  });

  test("a revoked waiver does not redeem", () => {
    store.createWaiver({ codeHash: hash("c3"), note: "x", createdAt: 1_000 });
    expect(store.revokeWaiver(hash("c3"))).toBe(true);
    expect(store.redeemWaiver(hash("c3"), TENANT, 2_000)).toBeUndefined();
    expect(store.revokeWaiver(hash("c3"))).toBe(false); // already gone
  });

  test("listWaivers shows issuance and redemption state", () => {
    store.createWaiver({ codeHash: hash("c4"), note: "eu-guardian", createdAt: 1_000 });
    store.redeemWaiver(hash("c4"), TENANT, 2_000);
    const rows = store.listWaivers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      codeHash: hash("c4"),
      note: "eu-guardian",
      redeemedBy: TENANT,
      redeemedAt: 2_000,
    });
  });
});

// ── Route: POST /world-id/waiver ────────────────────────────────────────────────────────────────

function makeApp() {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo: new SqliteEntityRepository(db),
    docStore: new FileDocumentStore(mkdtempSync(join(tmpdir(), "waiver-"))),
    worldId: {
      cfg: {
        appId: "app_x",
        rpId: "rp_x",
        rpSigningKey: `0x${"1".repeat(64)}`,
        action: ACTION,
        environment: "staging" as const,
      },
      store,
      requireGuardian: true,
    },
  } as never);
}

async function bearer(tenant: string) {
  const { token } = await signSession(tenant, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("POST /world-id/waiver", () => {
  test("redeeming a valid code satisfies the guardian gate, honestly labeled", async () => {
    store.createWaiver({ codeHash: hash("nvw_good"), note: "colleague", createdAt: 1 });
    const app = makeApp();
    const res = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(TENANT),
      body: JSON.stringify({ code: "nvw_good" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; credential: string };
    expect(body.status).toBe("verified");
    expect(body.credential).toBe("waiver");

    // The onboarding gate now passes for this tenant…
    const world = {
      cfg: { action: ACTION } as never,
      store,
      requireGuardian: true,
    };
    expect(() => assertGuardianAllowed(world as never, TENANT)).not.toThrow();

    // …and /me reports the truthful credential.
    const me = (await (
      await app.request("/world-id/me", { headers: await bearer(TENANT) })
    ).json()) as { verified: boolean; credential: string };
    expect(me.verified).toBe(true);
    expect(me.credential).toBe("waiver");
  });

  test("an invalid code is refused and the gate stays shut", async () => {
    const app = makeApp();
    const res = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(TENANT),
      body: JSON.stringify({ code: "nvw_wrong" }),
    });
    expect(res.status).toBe(404);
    const world = { cfg: { action: ACTION } as never, store, requireGuardian: true };
    expect(() => assertGuardianAllowed(world as never, TENANT)).toThrow(/World ID/);
  });

  test("a code cannot be redeemed by a second tenant", async () => {
    store.createWaiver({ codeHash: hash("nvw_once"), note: "x", createdAt: 1 });
    const app = makeApp();
    const first = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(TENANT),
      body: JSON.stringify({ code: "nvw_once" }),
    });
    expect(first.status).toBe(200);
    const second = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(OTHER),
      body: JSON.stringify({ code: "nvw_once" }),
    });
    expect(second.status).toBe(404); // indistinguishable from never-existed, by design
  });

  test("a tenant with a real verification keeps it — waiver refuses to downgrade", async () => {
    store.recordVerification({
      nullifier: "999",
      action: ACTION,
      tenantId: TENANT,
      issuerSchemaId: 1,
      credential: "proof_of_human",
      environment: "staging",
      verifiedAt: 1,
      expiresAtMin: null,
    });
    store.createWaiver({ codeHash: hash("nvw_dup"), note: "x", createdAt: 1 });
    const app = makeApp();
    const res = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(TENANT),
      body: JSON.stringify({ code: "nvw_dup" }),
    });
    expect(res.status).toBe(409);
    // The stronger credential is still what /me reports.
    const me = (await (
      await app.request("/world-id/me", { headers: await bearer(TENANT) })
    ).json()) as { credential: string };
    expect(me.credential).toBe("proof_of_human");
  });
});

// ── Metadata honesty ────────────────────────────────────────────────────────────────────────────

describe("metadata — a waiver never claims a verified human", () => {
  const PUBLIC_ID = "33333333-3333-3333-3333-333333333333";
  const KEY = "0xAAA:agent";

  test("waived guardian -> worldId block present but humanVerified: false", async () => {
    const repo = new SqliteEntityRepository(db);
    const docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "waiver-meta-")));
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
    repo.upsert(rec);
    docStore.put(`meta-${KEY}.json`, JSON.stringify({ name: "A" }));
    store.createWaiver({ codeHash: hash("nvw_meta"), note: "x", createdAt: 1 });

    const app = buildApiApp({
      webOrigin: "*",
      jwtSecret: JWT_SECRET,
      repo,
      docStore,
      worldId: {
        cfg: {
          appId: "app_x",
          rpId: "rp_x",
          rpSigningKey: `0x${"1".repeat(64)}`,
          action: ACTION,
          environment: "staging" as const,
        },
        store,
        requireGuardian: true,
      },
    } as never);

    const redeem = await app.request("/world-id/waiver", {
      method: "POST",
      headers: await bearer(TENANT),
      body: JSON.stringify({ code: "nvw_meta" }),
    });
    expect(redeem.status).toBe(200);

    const body = (await (await app.request(`/metadata/${PUBLIC_ID}`)).json()) as {
      worldId?: { humanVerified: boolean; credential: string };
    };
    expect(body.worldId?.credential).toBe("waiver");
    expect(body.worldId?.humanVerified).toBe(false); // a waiver is access, not verification
  });
});
