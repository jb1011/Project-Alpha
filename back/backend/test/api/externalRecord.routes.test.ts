/**
 * `GET /entities/:id/external-record` (design 2026-10-23, section 4.2) and `/config.externalRecord`:
 * tenant-scoped, 409 before the identity exists, not mounted without a provider, a definitive
 * answer served from memory for 60 s and a failed one never, and `no-store` on every answer.
 *
 * The read is a stub here; its composition is `test/trackRecord/read.test.ts`.
 */
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { buildApiApp } from "../../src/api/app";
import type { ExternalRecordDeps } from "../../src/api/routes/externalRecord";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { ExternalRecordAnswer } from "../../src/trackRecord/read";
import type { ExternalRecordView } from "../../src/trackRecord/types";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

// Anvil's published test accounts, never real.
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const otherAccount = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

const VIEW: ExternalRecordView = {
  provider: { name: "Aevum", recordUrl: "https://app.aevumprotocol.io/check/0x1" },
  agentId: "895447",
  chain: {
    status: "ok",
    graded: 2,
    correct: 1,
    wrong: 1,
    unrecognised: 0,
    lastGradedAt: "2026-11-02T15:16:00.000Z",
  },
  record: {
    status: "ok",
    lockingWallet: "0x33F283b1d6e9a12b0F79289C75617E6c0f56Aff8",
    graded: 2,
    correct: 1,
    wrong: 1,
    worstMoveBps: -314,
  },
  agreement: "match",
  network: "testnet",
  checkedAt: "2026-11-03T10:00:00.000Z",
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let clock: number;

function makeApp(externalRecord?: ExternalRecordDeps) {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
  });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys: new SqliteApiKeyStore(db),
    arc: {} as ArcAdapter,
    now: () => clock,
    externalRecord,
  } as never);
}

async function login(app: ReturnType<typeof buildApiApp>, acct = account) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: acct.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await acct.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

function seed(tenant: string, key: string, agentId: string | null = "895447") {
  const id = `${tenant}:${key}`;
  repo.upsert({
    idempotencyKey: id,
    name: "A",
    status: agentId ? "bound" : "pending",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: tenant as `0x${string}`,
    operator: null,
    amendmentDelay: "0",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId,
    proxy: null,
    treasury: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: tenant,
  } as never);
  return id;
}

function stub(
  answers: ExternalRecordAnswer[],
): ExternalRecordDeps & { read: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    providerName: "Aevum",
    read: vi.fn(async () => answers[Math.min(i++, answers.length - 1)] as ExternalRecordAnswer),
  };
}

async function get(app: ReturnType<typeof buildApiApp>, id: string, token: string) {
  return app.request(`/entities/${encodeURIComponent(id)}/external-record`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  clock = Date.parse("2026-11-03T10:00:00Z");
});
afterEach(() => db.close());

describe("GET /entities/:id/external-record", () => {
  test("the owner gets the view, with the agent id read from the entity", async () => {
    const deps = stub([{ view: VIEW, definitive: true }]);
    const app = makeApp(deps);
    const token = await login(app);
    const id = seed(account.address, "a1");

    const res = await get(app, id, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(deps.read).toHaveBeenCalledWith(895447n);
  });

  test("another tenant's entity is 404 and reads nothing", async () => {
    const deps = stub([{ view: VIEW, definitive: true }]);
    const app = makeApp(deps);
    const id = seed(account.address, "a1");
    const otherToken = await login(app, otherAccount);

    expect((await get(app, id, otherToken)).status).toBe(404);
    expect(deps.read).not.toHaveBeenCalled();
  });

  test("an unknown entity is 404", async () => {
    const app = makeApp(stub([{ view: VIEW, definitive: true }]));
    const token = await login(app);
    expect((await get(app, `${account.address}:nope`, token)).status).toBe(404);
  });

  test("an entity with no identity yet is 409 not_ready", async () => {
    const app = makeApp(stub([{ view: VIEW, definitive: true }]));
    const token = await login(app);
    const id = seed(account.address, "a1", null);
    const res = await get(app, id, token);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_ready");
  });

  test("without sign-in it is 401", async () => {
    const app = makeApp(stub([{ view: VIEW, definitive: true }]));
    const id = seed(account.address, "a1");
    expect((await app.request(`/entities/${encodeURIComponent(id)}/external-record`)).status).toBe(
      401,
    );
  });

  test("not mounted without a provider: 404", async () => {
    const app = makeApp(undefined);
    const token = await login(app);
    const id = seed(account.address, "a1");
    expect((await get(app, id, token)).status).toBe(404);
  });

  test("a definitive answer is served from memory for 60 s, then read again", async () => {
    const later = { ...VIEW, checkedAt: "2026-11-03T10:01:01.000Z" };
    const deps = stub([
      { view: VIEW, definitive: true },
      { view: later, definitive: true },
    ]);
    const app = makeApp(deps);
    const token = await login(app);
    const id = seed(account.address, "a1");

    await get(app, id, token);
    clock += 59_000;
    expect(await (await get(app, id, token)).json()).toEqual(VIEW);
    expect(deps.read).toHaveBeenCalledTimes(1);

    clock += 2_000;
    expect(await (await get(app, id, token)).json()).toEqual(later);
    expect(deps.read).toHaveBeenCalledTimes(2);
  });

  test("an answer with a half unavailable is never kept", async () => {
    const failed: ExternalRecordView = {
      ...VIEW,
      chain: { status: "unavailable", reason: "rpc" },
      agreement: "unknown",
    };
    const deps = stub([
      { view: failed, definitive: false },
      { view: VIEW, definitive: true },
    ]);
    const app = makeApp(deps);
    const token = await login(app);
    const id = seed(account.address, "a1");

    expect((await (await get(app, id, token)).json()).chain.status).toBe("unavailable");
    expect((await (await get(app, id, token)).json()).chain.status).toBe("ok");
    expect(deps.read).toHaveBeenCalledTimes(2);
  });
});

describe("/config.externalRecord", () => {
  test("available with the provider's name when configured", async () => {
    const app = makeApp(stub([{ view: VIEW, definitive: true }]));
    expect((await (await app.request("/config")).json()).externalRecord).toEqual({
      available: true,
      providerName: "Aevum",
    });
  });

  test("unavailable without a provider", async () => {
    const app = makeApp(undefined);
    expect((await (await app.request("/config")).json()).externalRecord).toEqual({
      available: false,
      providerName: null,
    });
  });
});
