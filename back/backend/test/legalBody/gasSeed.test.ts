/**
 * The gas seed: a small native amount the platform sends once per tenant, ever, to the owner of a
 * deployed order's identity, so that the owner can pay for the transaction that writes the
 * identity's pointer to its legal body.
 *
 * The database is real (in memory), and so is the platform's outflow meter over it. The owner's
 * code and balance and the send are fakes each test steers; the order deps' chain port throws on
 * any member, since the seed reads none of it. The door's tests go through the app with a real
 * session. Every name, company and filing number is an invention, and every key is one of anvil's
 * published test accounts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, keccak256, parseEther, toHex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { loadConfig } from "../../src/config/env";
import { ApiError } from "../../src/errors";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { type GasSeedDeps, requestGasSeed } from "../../src/legalBody/gasSeed";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { type OutflowMeter, buildOutflowMeter } from "../../src/payments/outflowMeter";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  H,
  IDENTITY_OWNER,
  JWT_SECRET,
  type LegalBodyStores,
  OTHER_FACTORY,
  TransportFailure,
  answerOf,
  call,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
  sessionOf,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. #2 and #3 are verified
 *  humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;
const tenant = guardian.address;
const other = stranger.address;
/** The owner of every identity here: the fixtures' identity owner, a key-controlled address. */
const owner = IDENTITY_OWNER.address;

/** 0.05 USDC, the largest seed a deployment may set, in wei: on Arc the native unit is USDC, with
 *  18 decimals. */
const SEED_WEI = 50_000_000_000_000_000n;
/** The same amount in millionths of a USDC, as the meter and the request's event count it. */
const SEED_MICRO_USDC = 50_000n;
/** The hash the fake send answers. */
const SEED_TX = H("5");
const HOUR = 3_600_000;
/** An EIP-7702 delegation designator: 0xef0100, then a placeholder delegate's 20 bytes. */
const DELEGATED_CODE = `0xef0100${"de1e9a7e".padStart(40, "0")}` as Hex;

const gasSeedPath = (id: string) => `/legal-body-orders/${id}/gas-seed`;

let db: Database.Database;
let s: LegalBodyStores;
let meter: OutflowMeter;
/** The meter's clock, in unix milliseconds. */
let meterClock: number;
let ownerChain: OwnerChain;
/** Every console line written in the test: the ops lines among them. */
let lines: string[];
let filings = 0;
let agents = 600;

const nowSeconds = () => Math.floor(Date.now() / 1_000);

/** The owner's two reads and the send, each a mock a test can steer. By default the owner has no
 *  code and no balance, and the send answers `SEED_TX`. */
function fakeOwnerChain() {
  return {
    readCode: vi.fn<GasSeedDeps["readCode"]>(async () => undefined),
    readBalance: vi.fn<GasSeedDeps["readBalance"]>(async () => 0n),
    sendNative: vi.fn<GasSeedDeps["sendNative"]>(async () => SEED_TX),
  };
}
type OwnerChain = ReturnType<typeof fakeOwnerChain>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  meterClock = Date.now();
  meter = buildOutflowMeter(db, {
    ceilingAtomic: 200_000_000n,
    windowMs: 24 * HOUR,
    now: () => meterClock,
  });
  ownerChain = fakeOwnerChain();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(s.store, tenant, "5001", Date.now());
  recordHuman(s.store, other, "5002", Date.now());
  recordHuman(s.store, waived.address, "5003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The order doors' deps of a sandbox deployment, with room in every throttle and every cap. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { maxOpenPerTenant: 50, maxOrdersPerTenantPerDay: 50, ...over });
}

/** The seed's deps: 0.05 USDC, the fake owner chain, and the real meter, asked and fed as the
 *  composition root asks and feeds it. */
function seedDeps(
  over: Partial<GasSeedDeps> = {},
  orders: Partial<LegalBodyOrderDeps> = {},
): GasSeedDeps {
  return {
    orders: orderDeps(orders),
    amountWei: SEED_WEI,
    readCode: ownerChain.readCode,
    readBalance: ownerChain.readBalance,
    checkOutflow: vi.fn((valueAtomic: bigint) => meter.check(valueAtomic)),
    sendNative: ownerChain.sendNative,
    recordOutflow: vi.fn((valueAtomic: bigint, hash: Hex) =>
      meter.record("gas_seed", valueAtomic, hash),
    ),
    ...over,
  };
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of `who`, placed through the order door for a checked company of its own. */
function draft(who: Address, orders: Partial<LegalBodyOrderDeps> = {}): LegalBodyRecord {
  const companyId = customerCompany(s, who, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  return rowOf(createOrder(orderDeps(orders), who, { companyId }).id);
}

/** The draft reserved through the repository, for an identity of its own that `owner` holds. The
 *  signature is a placeholder: nothing here checks it. */
function reserved(who: Address, orders: Partial<LegalBodyOrderDeps> = {}): LegalBodyRecord {
  const id = draft(who, orders).legalBodyId;
  const n = ++agents;
  expect(
    s.repo.reserve(id, {
      agentId: String(n),
      identityOwner: owner,
      linkDigest: keccak256(toHex(`link-${n}`)),
      linkDeadline: nowSeconds() + 3_600,
      linkSignature: `0x${"ab".repeat(65)}` as Hex,
      bodyAddress: getAddress(`0x${keccak256(toHex(`body-${n}`)).slice(-40)}`),
      observedAtBlock: 8_000,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  return rowOf(id);
}

/** The body created on chain a minute ago: the order is `deployed`, and only the pointer is
 *  missing. */
function deployed(who: Address, orders: Partial<LegalBodyOrderDeps> = {}): LegalBodyRecord {
  const id = reserved(who, orders).legalBodyId;
  expect(
    s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`create-${id}`)),
      deployedAt: nowSeconds() - 60,
    }),
  ).toBe(true);
  return rowOf(id);
}

/** The tenant's gas-seed events across all its orders, counted by kind. */
const seedCounts = (who: Address) => ({
  requested: s.repo.countEventsByTenant(who, "gas_seed_requested"),
  seeded: s.repo.countEventsByTenant(who, "gas_seeded"),
});

/** An order's gas-seed events, oldest first, as recorded. */
const seedEvents = (id: string) =>
  s.repo
    .listEvents(id)
    .filter((e) => e.kind === "gas_seed_requested" || e.kind === "gas_seeded")
    .map(({ kind, actor, txHash, detail }) => ({ kind, actor, txHash, detail }));

/** The platform's outflows, oldest first. */
const outflowRows = () =>
  db.prepare("SELECT path, amount, ref FROM platform_outflows ORDER BY id").all();

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

/** That `run` ends in the refusal `code`: an `ApiError` with this status and the code's fixed
 *  sentence. */
async function refused(run: () => Promise<unknown>, code: string, status: number): Promise<void> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `the refusal ${code}`).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ code, status, message: LEGAL_BODY_SENTENCES[code] });
}

/** That nothing was read, counted, recorded or sent. */
function nothingTouched(d: GasSeedDeps): void {
  expect(ownerChain.readCode).not.toHaveBeenCalled();
  expect(ownerChain.readBalance).not.toHaveBeenCalled();
  expect(d.checkOutflow).not.toHaveBeenCalled();
  expect(ownerChain.sendNative).not.toHaveBeenCalled();
  expect(outflowRows()).toEqual([]);
}

// ── Seeded once ─────────────────────────────────────────────────────────────────────────────

describe("a key-controlled owner below the amount", () => {
  test("is seeded once: the request is recorded, the amount sent, the seed recorded with its hash and counted as an outflow; another order of the same tenant is then refused with gas_seed_used", async () => {
    const first = deployed(tenant);
    const second = deployed(tenant);
    const d = seedDeps();

    expect(await requestGasSeed(d, tenant, first.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });
    expect(ownerChain.readCode.mock.calls).toEqual([[owner]]);
    expect(ownerChain.readBalance.mock.calls).toEqual([[owner]]);
    expect(ownerChain.sendNative.mock.calls).toEqual([[owner, SEED_WEI]]);
    // The meter counts 6-decimal USDC: the native value divided by 10^12.
    expect(d.checkOutflow).toHaveBeenCalledWith(SEED_MICRO_USDC);
    expect(d.recordOutflow).toHaveBeenCalledWith(SEED_MICRO_USDC, SEED_TX);
    expect(seedEvents(first.legalBodyId)).toEqual([
      {
        kind: "gas_seed_requested",
        actor: "tenant",
        txHash: null,
        detail: { to: owner, microUsdc: 50_000 },
      },
      { kind: "gas_seeded", actor: "system", txHash: SEED_TX, detail: null },
    ]);
    expect(outflowRows()).toEqual([{ path: "gas_seed", amount: 50_000, ref: SEED_TX }]);

    // Once per tenant, ever: neither another of its orders nor the same one is seeded again.
    for (const row of [second, first])
      await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "gas_seed_used", 409);
    expect(ownerChain.sendNative).toHaveBeenCalledTimes(1);
    expect(seedEvents(second.legalBodyId)).toEqual([]);
    expect(seedCounts(tenant)).toEqual({ requested: 1, seeded: 1 });
    expect(outflowRows()).toHaveLength(1);

    // Another tenant has a seed of its own.
    const theirs = deployed(other);
    expect(await requestGasSeed(d, other, theirs.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });
    expect(seedCounts(other)).toEqual({ requested: 1, seeded: 1 });
  });

  test("two requests at the same time, for two orders of one tenant, seed exactly once", async () => {
    const first = deployed(tenant);
    const second = deployed(tenant);
    // Neither request leaves its balance read before both are in it, so both have passed every
    // read before either reaches the once-ever count.
    let inRead = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    ownerChain.readBalance.mockImplementation(async () => {
      if (++inRead === 2) release();
      await bothRead;
      return 0n;
    });
    const d = seedDeps();

    const results = await Promise.allSettled([
      requestGasSeed(d, tenant, first.legalBodyId),
      requestGasSeed(d, tenant, second.legalBodyId),
    ]);

    expect(ownerChain.readBalance).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: { status: "sent", txHash: SEED_TX } },
    ]);
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toBeInstanceOf(ApiError);
    expect(losers[0]?.reason).toMatchObject({ code: "gas_seed_used", status: 409 });
    expect(ownerChain.sendNative).toHaveBeenCalledTimes(1);
    expect(seedCounts(tenant)).toEqual({ requested: 1, seeded: 1 });
    expect(outflowRows()).toEqual([{ path: "gas_seed", amount: 50_000, ref: SEED_TX }]);
  });
});

// ── Refused ─────────────────────────────────────────────────────────────────────────────────

describe("refused", () => {
  test("off: an amount of 0 answers 409 gas_seed_disabled before anything is read, and spends no token", async () => {
    const row = deployed(tenant);
    const tenantBucket = vi.fn(() => ({ take: () => true }));
    const doorBudget = { take: vi.fn(() => true) };
    const findByTenant = vi.spyOn(s.store, "findByTenant");
    const d = seedDeps({ amountWei: 0n }, { tenantBucket, doorBudget });

    await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "gas_seed_disabled", 409);

    expect(findByTenant).not.toHaveBeenCalled();
    expect(tenantBucket).not.toHaveBeenCalled();
    expect(doorBudget.take).not.toHaveBeenCalled();
    nothingTouched(d);
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
  });

  test("an order that is not deployed answers 409 order_closed, with nothing read", async () => {
    const drafted = draft(tenant);
    const waiting = reserved(tenant);
    const lapsed = reserved(tenant);
    expect(
      s.repo.lapse(lapsed.legalBodyId, { reason: "deadline_passed", blockTime: nowSeconds() }),
    ).toBe(true);
    const abandoned = draft(tenant);
    expect(s.repo.abandon(abandoned.legalBodyId, "tenant_request", "tenant")).toBe(true);
    const linked = deployed(tenant);
    expect(s.repo.markLinked(linked.legalBodyId, nowSeconds())).toMatchObject({
      outcome: "linked",
    });
    const d = seedDeps();

    for (const row of [drafted, waiting, lapsed, abandoned, linked])
      await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "order_closed", 409);

    nothingTouched(d);
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
  });

  test("another tenant's order and an unknown id answer the uniform 404; an order of another deployment, 409 other_deployment; nothing is read", async () => {
    const theirs = deployed(other);
    const elsewhere = deployed(tenant, {
      deployment: { chainId: CHAIN_ID, factory: OTHER_FACTORY },
    });
    const d = seedDeps();

    for (const id of [theirs.legalBodyId, "lb_unknown"])
      await refused(() => requestGasSeed(d, tenant, id), "not_found", 404);
    await refused(() => requestGasSeed(d, tenant, elsewhere.legalBodyId), "other_deployment", 409);

    nothingTouched(d);
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
    expect(seedCounts(other)).toEqual({ requested: 0, seeded: 0 });
  });

  test("an owner with contract code answers 409 owner_pays_own_gas, and its balance is not read", async () => {
    const row = deployed(tenant);
    const d = seedDeps();
    const codes: Hex[] = [
      // A contract's code.
      "0x6080604052",
      // 23 bytes that are not a delegation.
      `0x${"60".repeat(23)}`,
      // A delegation's prefix, one byte too long and one byte too short.
      `0xef0100${"00".repeat(21)}`,
      `0xef0100${"00".repeat(19)}`,
    ];

    for (const code of codes) {
      ownerChain.readCode.mockResolvedValueOnce(code);
      await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "owner_pays_own_gas", 409);
    }

    expect(ownerChain.readCode).toHaveBeenCalledTimes(codes.length);
    expect(ownerChain.readBalance).not.toHaveBeenCalled();
    expect(d.checkOutflow).not.toHaveBeenCalled();
    expect(ownerChain.sendNative).not.toHaveBeenCalled();
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
  });

  test("an owner delegated under EIP-7702, 23 bytes of code starting 0xef0100, is seeded", async () => {
    const row = deployed(tenant);
    ownerChain.readCode.mockResolvedValue(DELEGATED_CODE);

    expect(await requestGasSeed(seedDeps(), tenant, row.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });

    // The same designator in upper-case hex is the same delegation.
    ownerChain.readCode.mockResolvedValue(DELEGATED_CODE.toUpperCase().replace("0X", "0x") as Hex);
    const theirs = deployed(other);
    expect(await requestGasSeed(seedDeps(), other, theirs.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });
    expect(ownerChain.sendNative).toHaveBeenCalledTimes(2);
  });

  test("an owner holding the amount or more answers 409 not_needed, and a refusal spends nothing: one wei below, the same tenant is seeded", async () => {
    const row = deployed(tenant);
    const d = seedDeps();

    for (const balance of [SEED_WEI, SEED_WEI + 1n, 10n ** 18n]) {
      ownerChain.readBalance.mockResolvedValueOnce(balance);
      await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "not_needed", 409);
    }
    expect(d.checkOutflow).not.toHaveBeenCalled();
    expect(ownerChain.sendNative).not.toHaveBeenCalled();
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });

    ownerChain.readBalance.mockResolvedValueOnce(SEED_WEI - 1n);
    expect(await requestGasSeed(d, tenant, row.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });
  });
});

// ── The meter, the record and the send ──────────────────────────────────────────────────────

describe("the outflow meter is asked first, and the request is recorded before the send", () => {
  test("the meter over its limit answers 503 busy and records nothing, and a later request of the same tenant is seeded; the meter is asked in 6-decimal USDC", async () => {
    // A ceiling of 0.10 USDC an hour, 0.06 of which is already spent: a 0.05 seed would cross it.
    const tight = buildOutflowMeter(db, {
      ceilingAtomic: 100_000n,
      windowMs: HOUR,
      now: () => meterClock,
    });
    tight.record("fund_treasury", 60_000n, null);
    const checkOutflow = vi.fn((valueAtomic: bigint) => tight.check(valueAtomic));
    const recordOutflow = vi.fn((valueAtomic: bigint, hash: Hex) =>
      tight.record("gas_seed", valueAtomic, hash),
    );
    const d = seedDeps({ checkOutflow, recordOutflow });
    const row = deployed(tenant);

    await refused(() => requestGasSeed(d, tenant, row.legalBodyId), "busy", 503);

    expect(checkOutflow.mock.calls).toEqual([[SEED_MICRO_USDC]]);
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
    expect(ownerChain.sendNative).not.toHaveBeenCalled();
    expect(recordOutflow).not.toHaveBeenCalled();

    // An hour later the earlier outflow has left the window, and the tenant's seed is still there.
    meterClock += HOUR;
    expect(await requestGasSeed(d, tenant, row.legalBodyId)).toEqual({
      status: "sent",
      txHash: SEED_TX,
    });
    expect(checkOutflow.mock.calls).toEqual([[SEED_MICRO_USDC], [SEED_MICRO_USDC]]);
    expect(outflowRows()).toEqual([
      { path: "fund_treasury", amount: 60_000, ref: null },
      { path: "gas_seed", amount: 50_000, ref: SEED_TX },
    ]);
    expect(seedCounts(tenant)).toEqual({ requested: 1, seeded: 1 });
  });

  test("a send that throws leaves the request recorded and no gas_seeded, answers 503 gas_seed_unconfirmed, and the seed is spent", async () => {
    const first = deployed(tenant);
    const second = deployed(tenant);
    let requestedAtSend: number | undefined;
    ownerChain.sendNative.mockImplementation(async () => {
      requestedAtSend = s.repo.countEventsByTenant(tenant, "gas_seed_requested");
      throw new TransportFailure();
    });
    const d = seedDeps();
    lines.length = 0;

    await refused(() => requestGasSeed(d, tenant, first.legalBodyId), "gas_seed_unconfirmed", 503);

    // Recorded before the send, and never followed by a seeded event or an outflow.
    expect(requestedAtSend).toBe(1);
    expect(seedEvents(first.legalBodyId).map((e) => e.kind)).toEqual(["gas_seed_requested"]);
    expect(seedCounts(tenant)).toEqual({ requested: 1, seeded: 0 });
    expect(d.recordOutflow).not.toHaveBeenCalled();
    expect(outflowRows()).toEqual([]);
    // One line for the operator: the order, the stage and the error's name, and no URL.
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_chain_unavailable",
        orderId: first.legalBodyId,
        stage: "gas_seed_send",
        errorName: "HttpRequestError",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("http");

    // The seed is spent: the tenant's next request is refused, and nothing is sent again.
    await refused(() => requestGasSeed(d, tenant, second.legalBodyId), "gas_seed_used", 409);
    expect(ownerChain.sendNative).toHaveBeenCalledTimes(1);
  });
});

// ── The door ────────────────────────────────────────────────────────────────────────────────

/** The API over this test's database, with the order doors and the seed's door wired as the
 *  composition root wires them: the seed's `orders` are the doors' own deps. */
function makeApp(d: GasSeedDeps) {
  const requests = new SqliteFormationRepository(db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: d.orders,
    legalBodyGasSeed: d,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}

describe("the door, POST /legal-body-orders/:id/gas-seed", () => {
  test("seeds the owner and answers 200 with the hash; off, it answers 409 gas_seed_disabled", async () => {
    const row = deployed(tenant);
    const token = await sessionOf(guardian);

    const off = await answerOf(
      await call(makeApp(seedDeps({ amountWei: 0n })), "POST", gasSeedPath(row.legalBodyId), token),
    );
    expect(off).toMatchObject({
      status: 409,
      body: {
        error: { code: "gas_seed_disabled", message: LEGAL_BODY_SENTENCES.gas_seed_disabled },
      },
    });

    const sent = await answerOf(
      await call(makeApp(seedDeps()), "POST", gasSeedPath(row.legalBodyId), token),
    );
    expect(sent).toMatchObject({ status: 200, body: { status: "sent", txHash: SEED_TX } });
    expect(Object.keys(sent.body).sort()).toEqual(["status", "txHash"]);
    expect(ownerChain.sendNative.mock.calls).toEqual([[owner, SEED_WEI]]);
  });

  test("a waiver tenant is refused with 403, another tenant's order is the uniform 404, a caller with no session is a 401, and nobody is seeded", async () => {
    const row = deployed(tenant);
    // The waiver's own order is written through the repository: no door would make one.
    const own = s.repo.create({
      tenantId: waived.address,
      companyId: customerCompany(s, waived.address, { filingNumber: "TEST-9001" }),
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const app = makeApp(seedDeps());

    expect(
      await answerOf(
        await call(app, "POST", gasSeedPath(own.legalBodyId), await sessionOf(waived)),
      ),
    ).toMatchObject({ status: 403, body: { error: { code: "waiver_not_accepted" } } });
    expect(
      await answerOf(
        await call(app, "POST", gasSeedPath(row.legalBodyId), await sessionOf(stranger)),
      ),
    ).toMatchObject({
      status: 404,
      body: { error: { code: "not_found", message: LEGAL_BODY_SENTENCES.not_found } },
    });
    expect((await call(app, "POST", gasSeedPath(row.legalBodyId), undefined)).status).toBe(401);

    expect(ownerChain.readCode).not.toHaveBeenCalled();
    expect(ownerChain.sendNative).not.toHaveBeenCalled();
    for (const who of [tenant, other, waived.address])
      expect(seedCounts(who)).toEqual({ requested: 0, seeded: 0 });
  });

  test("a balance read that throws an error carrying a URL answers 503 chain_unavailable, with no http in the answer or the log, and records nothing", async () => {
    const row = deployed(tenant);
    ownerChain.readBalance.mockRejectedValue(new TransportFailure());
    const token = await sessionOf(guardian);
    lines.length = 0;

    const res = await answerOf(
      await call(makeApp(seedDeps()), "POST", gasSeedPath(row.legalBodyId), token),
    );

    expect(res).toMatchObject({
      status: 503,
      body: {
        error: { code: "chain_unavailable", message: LEGAL_BODY_SENTENCES.chain_unavailable },
      },
    });
    expect(res.text).not.toContain("http");
    expect(opsLines()).toEqual([
      expect.objectContaining({
        opslog: "legal_body_chain_unavailable",
        orderId: row.legalBodyId,
        stage: "gas_seed_balance",
        errorName: "HttpRequestError",
      }),
    ]);
    expect(lines.join("\n")).not.toContain("http");
    expect(seedCounts(tenant)).toEqual({ requested: 0, seeded: 0 });
    expect(ownerChain.sendNative).not.toHaveBeenCalled();
  });
});

// ── The composition and the configuration ───────────────────────────────────────────────────

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file.
 * What it protects: the seed exists wherever the order doors do, over the same order deps; its
 * amount is the configured one, 0 (off) when unset; its two reads are the public client's; the
 * meter is asked and fed on the `gas_seed` path; the send is the platform's one native send; and
 * the API is handed the seed beside the doors.
 */
test("the composition root builds the seed's deps beside the order doors' and hands them to the API", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const legalBodyGasSeed");
  expect(at, "the seed's deps were not found").toBeGreaterThan(0);
  const built = main.slice(at, main.indexOf(": undefined;", at));
  expect(built).toMatch(/= legalBodyOrders\n\s+\? \{\n\s+orders: legalBodyOrders,\n/);
  expect(built).toMatch(/amountWei: parseEther\(cfg\.legalBodyGasSeedUsdc \?\? "0"\),/);
  expect(built).toMatch(/readCode: \(address\) => publicClient\.getCode\(\{ address \}\),/);
  expect(built).toMatch(/readBalance: \(address\) => publicClient\.getBalance\(\{ address \}\),/);
  expect(built).toMatch(/checkOutflow: \(valueAtomic\) => outflows\.check\(valueAtomic\),/);
  expect(built).toMatch(/sendNative: \(to, value\) => arc\.sendNativeAsPlatform\(to, value\),/);
  expect(built).toMatch(
    /recordOutflow: \(valueAtomic, hash\) =>\s+outflows\.record\("gas_seed", valueAtomic, hash\),/,
  );
  expect(main).toMatch(/^ {4}legalBodyOrders,\n(?: {4}\/\/.*\n)* {4}legalBodyGasSeed,$/m);
});

describe("LEGAL_BODY_GAS_SEED_USDC", () => {
  const BASE = {
    ARC_TESTNET_RPC_URL: "https://rpc.example",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  };
  /** The legal-body feature on: controller mode and both factories. */
  const FEATURE_ON = {
    ...BASE,
    CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
    FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
    LEGAL_BODY_FACTORY_ADDRESS: "0x3333333333333333333333333333333333333333",
  };

  test("unset, blank or zero, the seed is off", () => {
    for (const env of [BASE, FEATURE_ON]) {
      expect(loadConfig(env).legalBodyGasSeedUsdc).toBe("0");
      for (const off of ["", "  ", "0", "0.000000"]) {
        const amount = loadConfig({ ...env, LEGAL_BODY_GAS_SEED_USDC: off }).legalBodyGasSeedUsdc;
        expect(parseEther(amount ?? "missing"), JSON.stringify(off)).toBe(0n);
      }
    }
  });

  test("takes a decimal of at most 0.05 USDC with at most 6 decimals", () => {
    for (const ok of ["0.05", "0.050000", "0.01", "0.000001"])
      expect(loadConfig({ ...FEATURE_ON, LEGAL_BODY_GAS_SEED_USDC: ok }).legalBodyGasSeedUsdc).toBe(
        ok,
      );
    expect(
      loadConfig({ ...FEATURE_ON, LEGAL_BODY_GAS_SEED_USDC: " 0.05 " }).legalBodyGasSeedUsdc,
    ).toBe("0.05");
    expect(parseEther("0.05")).toBe(SEED_WEI);
  });

  test("refuses 0.06, and an amount that is not a plain decimal of at most 6 decimals, the feature on or off", () => {
    for (const bad of [
      "0.06",
      "0.050001",
      "1",
      "-0.01",
      "0.0000001",
      "1e-2",
      ".05",
      "0,05",
      "five cents",
    ])
      for (const env of [BASE, FEATURE_ON])
        expect(() => loadConfig({ ...env, LEGAL_BODY_GAS_SEED_USDC: bad }), bad).toThrow(
          /LEGAL_BODY_GAS_SEED_USDC/,
        );
  });
});
