/**
 * The schedule record (design 2026-10-23, section 4.5): the policy change this backend scheduled
 * survives a page reload. `POST /entities/:id/policy` records it with the treasury's own policy
 * id, `GET /entities/:id` carries it, an execute of the same id clears it, an execute of another
 * id does not, and no ordinary record write erases it.
 */
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { computePolicyId } from "../../src/policy/policyId";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";

// Anvil's published test account, never real.
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const TX = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
/** The payout of the vector below, in lowercase as a form may send it. */
const PAYOUT = "0x000000000000000000000000000000000000000a";
/**
 * `cast keccak $(cast abi-encode "f(uint256,uint256,bool,address)" 10000000 86400 false
 * 0x000000000000000000000000000000000000000A)`, computed 2026-10-28.
 */
const VECTOR_ID = "0x1b2e1ee9216d079fc407ca8232969574549bd0743987ac008f4fc182670c2e62";
const NOW = Date.parse("2026-11-12T09:00:00Z");

let db: Database.Database;
let repo: SqliteEntityRepository;

const STUB_ARC = {
  schedulePolicyUpdate: vi.fn(async () => TX),
  executePolicyUpdate: vi.fn(async () => TX),
} as unknown as ArcAdapter;

function makeApp() {
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
    arc: STUB_ARC,
    now: () => NOW,
  } as never);
}

async function login(app: ReturnType<typeof buildApiApp>) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = await account.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

function seed() {
  const id = `${account.address}:s1`;
  repo.upsert({
    idempotencyKey: id,
    name: "A",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: account.address,
    operator: null,
    amendmentDelay: "0",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: {
      usdc: "0x3600000000000000000000000000000000000000",
      payoutAddress: "0x000000000000000000000000000000000000000A",
      cap: 5_000_000n,
      period: 86_400n,
      allowlistEnabled: false,
    },
    agentId: "895447",
    proxy: null,
    treasury: "0x000000000000000000000000000000000000000F",
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: account.address,
  });
  return id;
}

async function schedule(app: ReturnType<typeof buildApiApp>, token: string, id: string) {
  return app.request(`/entities/${encodeURIComponent(id)}/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capUsdc: "10",
      periodSeconds: 86400,
      allowlistOn: false,
      payoutAddress: PAYOUT,
    }),
  });
}

async function execute(
  app: ReturnType<typeof buildApiApp>,
  token: string,
  id: string,
  policyId: string,
) {
  return app.request(`/entities/${encodeURIComponent(id)}/policy/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ policyId }),
  });
}

async function entityView(app: ReturnType<typeof buildApiApp>, token: string, id: string) {
  const res = await app.request(`/entities/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { scheduledPolicy: unknown };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  vi.clearAllMocks();
});
afterEach(() => db.close());

describe("computePolicyId", () => {
  test("matches the vector computed with cast", () => {
    expect(
      computePolicyId({
        cap: 10_000_000n,
        period: 86_400n,
        allowlistOn: false,
        payout: "0x000000000000000000000000000000000000000A",
      }),
    ).toBe(VECTOR_ID);
  });
});

describe("the schedule record", () => {
  test("a new entity has nothing scheduled", async () => {
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    expect((await entityView(app, token, id)).scheduledPolicy).toBeNull();
  });

  test("a schedule is recorded with the treasury's policy id and survives a reload", async () => {
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    expect((await schedule(app, token, id)).status).toBe(200);

    expect((await entityView(app, token, id)).scheduledPolicy).toEqual({
      policyId: VECTOR_ID,
      cap: "10000000",
      period: "86400",
      allowlistOn: false,
      payout: "0x000000000000000000000000000000000000000A",
      txHash: TX,
      scheduledAt: "2026-11-12T09:00:00.000Z",
    });
  });

  test("a failed schedule records nothing", async () => {
    vi.mocked(STUB_ARC.schedulePolicyUpdate).mockRejectedValueOnce(new Error("reverted"));
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    expect((await schedule(app, token, id)).status).toBe(500);
    expect((await entityView(app, token, id)).scheduledPolicy).toBeNull();
  });

  test("an execute of the same id clears it", async () => {
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    await schedule(app, token, id);
    expect((await execute(app, token, id, VECTOR_ID)).status).toBe(200);
    expect((await entityView(app, token, id)).scheduledPolicy).toBeNull();
  });

  test("an execute of another id leaves it", async () => {
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    await schedule(app, token, id);
    await execute(app, token, id, `0x${"ab".repeat(32)}`);
    expect((await entityView(app, token, id)).scheduledPolicy).toMatchObject({
      policyId: VECTOR_ID,
    });
  });

  test("an ordinary record write does not erase it", async () => {
    const app = makeApp();
    const token = await login(app);
    const id = seed();
    await schedule(app, token, id);
    // The per-tx cap route writes the whole record back through `upsert`.
    const rec = repo.findByIdempotencyKey(id)!;
    repo.upsert({ ...rec, perTxCap: 1_000_000n, scheduledPolicy: null });
    expect(repo.findByIdempotencyKey(id)?.scheduledPolicy).toMatchObject({ policyId: VECTOR_ID });
  });

  test("a stored value that does not parse reads as nothing scheduled", () => {
    const id = seed();
    db.prepare("UPDATE entities SET scheduled_policy_json = ? WHERE idempotency_key = ?").run(
      '{"policyId":1}',
      id,
    );
    expect(repo.findByIdempotencyKey(id)?.scheduledPolicy).toBeNull();
    db.prepare("UPDATE entities SET scheduled_policy_json = ? WHERE idempotency_key = ?").run(
      "not json",
      id,
    );
    expect(repo.findByIdempotencyKey(id)?.scheduledPolicy).toBeNull();
  });
});
