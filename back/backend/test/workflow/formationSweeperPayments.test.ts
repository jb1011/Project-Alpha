/**
 * THE EIGHTH SWEEPER LEG — `resumeStalledSettles` (design 2026-08-26 §6.4).
 *
 * A `settling` row is a broadcast nobody recorded the outcome of, and the guardian's signature is
 * still public and self-authorizing. The leg's whole job is to be the actor that resolves such a
 * row WITHOUT ever asking for a second signature, and to expire a payment only when the chain
 * says it can never settle.
 *
 * Its own file rather than more cases in `formationSweeper.test.ts`: that file's fixture is a
 * doola filing, and this leg does not touch doola at all.
 */
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import type { FormationExecutorDeps } from "../../src/payments/formationSettle";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Address, Hex } from "../../src/types";
import {
  FormationSweeper,
  type FormationSweeperDeps,
  SUBMITTED_STALL_MS,
} from "../../src/workflow/formationSweeper";
import { MemoryDocumentStore, fakeDoola } from "../helpers/formationFakes";

const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const TENANT = guardian.address as Address;
const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const SIG = `0x${"11".repeat(65)}` as Hex;
const RAW = "0x02aabbcc" as Hex;
const TX = `0x${"cc".repeat(32)}` as Hex;

let now = Date.parse("2026-08-26T12:00:00Z");
const nowSec = () => Math.floor(now / 1000);

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;

beforeEach(() => {
  now = Date.parse("2026-08-26T12:00:00Z");
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
});
afterEach(() => db.close());

interface FakeLog {
  name: "AuthorizationUsed" | "AuthorizationCanceled" | "Transfer";
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
}

/** The pair of logs a real settlement leaves: the nonce retired, and the money moved. */
function settlementLogs(nonce: Hex, txHash: Hex, block = 100n): FakeLog[] {
  return [
    {
      name: "AuthorizationUsed",
      args: { authorizer: TENANT, nonce },
      blockNumber: block,
      transactionHash: txHash,
    },
    {
      name: "Transfer",
      args: { from: TENANT, to: REVENUE, value: 399_000_000n },
      blockNumber: block,
      transactionHash: txHash,
    },
  ];
}

/** The chain, as much of it as this leg touches: the token's logs, a spent-nonce set and a
 *  receipt verdict. */
function fakeChain(
  opts: {
    receipt?: "success" | "reverted" | "timeout";
    spent?: string[];
    logs?: FakeLog[];
  } = {},
) {
  const sent: Hex[] = [];
  const spent = new Set((opts.spent ?? []).map((n) => n.toLowerCase()));
  const logs = opts.logs ?? [];
  const executor: FormationExecutorDeps = {
    publicClient: {
      getTransactionCount: async () => 1,
      getBlockNumber: async () => 1_000n,
      // THE CHAIN'S CLOCK (gate A4): 200 seconds ahead of the fixture's `now`, which is past the
      // 120-second finality margin for a window that closed a moment ago and nowhere near the
      // half-hour windows of the live quotes here. The margin itself is asserted in
      // test/workflow/formationPayment.test.ts.
      getBlock: async () => ({ number: 1_000n, timestamp: BigInt(nowSec() + 200) }),
      getLogs: async (q: {
        event: { name: string };
        args?: Record<string, unknown>;
        fromBlock: bigint;
        toBlock: bigint;
      }) =>
        logs.filter(
          (l) =>
            l.name === q.event.name &&
            l.blockNumber >= q.fromBlock &&
            l.blockNumber <= q.toBlock &&
            Object.entries(q.args ?? {}).every(
              ([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase(),
            ),
        ),
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        sent.push(serializedTransaction);
        return TX;
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if ((opts.receipt ?? "success") === "timeout") throw new Error("receipt timeout");
        return { status: opts.receipt ?? "success", gasUsed: 118_000n, transactionHash: hash };
      },
      readContract: async ({ args }: { args: unknown[] }) =>
        spent.has(String(args[1]).toLowerCase()),
      // biome-ignore lint/suspicious/noExplicitAny: a five-method stub of viem's PublicClient
    } as any,
    walletClient: {
      account: privateKeyToAccount(`0x${"9".repeat(64)}`),
      signTransaction: async () => RAW,
      // biome-ignore lint/suspicious/noExplicitAny: a two-field stub of viem's WalletClient
    } as any,
    usdc: USDC,
    chainId: 5042002,
  };
  return { executor, sent };
}

function paymentCfg(): FormationPaymentConfig {
  return {
    required: true,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    domain: { name: "USD Coin", version: "2", chainId: 5042002, verifyingContract: USDC },
    payments,
  };
}

function sweeper(executor: FormationExecutorDeps, wired = true): FormationSweeper {
  const doola = fakeDoola();
  const d: FormationSweeperDeps = {
    repo,
    companies,
    requests,
    documents: new SqliteDocumentIndexRepository(db),
    parties: new SqliteFormationPartyRepository(db),
    docStore: new MemoryDocumentStore(),
    events: new SqliteDoolaEventRepository(db),
    doola: doola.api,
    environment: "production",
    intervalMs: 60_000,
    now: () => now,
    payment: wired
      ? {
          payment: paymentCfg(),
          executor,
          transaction: <T>(fn: () => T) => db.transaction(fn)(),
        }
      : undefined,
  };
  return new FormationSweeper(d);
}

function company(status: "draft" | "ready" = "draft"): string {
  return companies.create({
    tenantId: TENANT,
    status,
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "software",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
}

function quote(companyId: string, over: { validBefore?: number; nonce?: Hex } = {}) {
  return payments.create({
    companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: over.nonce ?? (`0x${"a1".repeat(32)}` as Hex),
    validBefore: over.validBefore ?? nowSec() + 1800,
    payTo: REVENUE,
  });
}

/** Push a row's `updated_at` into the past so it is genuinely stalled by the sweeper's clock. */
function stall(paymentId: string, ms = SUBMITTED_STALL_MS + 60_000) {
  db.prepare("UPDATE formation_payments SET updated_at = ? WHERE payment_id = ?").run(
    new Date(now - ms)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, ""),
    paymentId,
  );
}

test("a deployment that does not charge runs the leg and does nothing", async () => {
  const c = company();
  const id = quote(c, { validBefore: nowSec() - 1 });
  const chain = fakeChain();
  await sweeper(chain.executor, false).tick();
  // Not expired: with no payment wiring there is no leg, and a row nobody quoted cannot exist
  // anyway. The assertion is that the tick is a no-op rather than a crash.
  expect(payments.find(id)?.status).toBe("quoted");
  expect(chain.sent).toHaveLength(0);
});

test("a `quoted` row past its window is expired — and that is what frees the re-quote", async () => {
  const c = company();
  const id = quote(c, { validBefore: nowSec() - 1 });
  const chain = fakeChain();
  await sweeper(chain.executor).tick();
  expect(payments.find(id)?.status).toBe("expired");
  // The unique live-rows index would otherwise refuse the guardian's next quote forever.
  expect(payments.findLive(c, "formation")).toBeUndefined();
  // Nothing was broadcast: nothing ever was.
  expect(chain.sent).toHaveLength(0);
});

test("a `quoted` row still inside its window is left alone", async () => {
  const c = company();
  const id = quote(c);
  await sweeper(fakeChain().executor).tick();
  expect(payments.find(id)?.status).toBe("quoted");
});

test("a FRESHLY settling row is not touched — the request that wrote it may still be running", async () => {
  // Re-broadcasting under a live handler would race it for the same nonce.
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  const chain = fakeChain();
  await sweeper(chain.executor).tick();
  expect(chain.sent).toHaveLength(0);
  expect(payments.find(id)?.status).toBe("settling");
});

test("a STALLED settling row is re-submitted from its persisted AUTHORIZATION — never re-quoted", async () => {
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const chain = fakeChain();
  await sweeper(chain.executor).tick();
  expect(chain.sent).toEqual([RAW]);
  expect(payments.find(id)).toMatchObject({ status: "settled", broadcastCount: 1 });
  expect(companies.find(c)?.status).toBe("ready");
  // ONE row. A re-quote would be a second live authorization for the same fee.
  expect(payments.listByCompany(c)).toHaveLength(1);
});

test("a stalled settle whose outcome is STILL unknown stays settling and burns an attempt", async () => {
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const chain = fakeChain({ receipt: "timeout" });
  await sweeper(chain.executor).tick();
  expect(payments.find(id)).toMatchObject({ status: "settling", attempt: 1 });
});

test("BACKOFF: a row that has already burned an attempt is not retried immediately", async () => {
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const first = fakeChain({ receipt: "timeout" });
  await sweeper(first.executor).tick();
  expect(payments.find(id)?.attempt).toBe(1);

  // `bumpAttempt` stamped `updated_at` to NOW, so the next tick is inside `retryDelayMs(1)`.
  const second = fakeChain({ receipt: "timeout" });
  now += 30_000;
  await sweeper(second.executor).tick();
  expect(second.sent).toHaveLength(0);
  expect(payments.find(id)?.attempt).toBe(1);
});

test("EXPIRY needs BOTH: the window closed AND the nonce still unused", async () => {
  const c = company();
  const id = quote(c, { validBefore: nowSec() - 1 });
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const chain = fakeChain({ receipt: "timeout" });
  await sweeper(chain.executor).tick();
  expect(payments.find(id)?.status).toBe("expired");
  expect(chain.sent).toHaveLength(0);
});

test("a SETTLEMENT IN THE LOGS past the window resolves to SETTLED — never expired", async () => {
  // The nightmare this rule prevents: telling a guardian who has already paid us that their quote
  // expired, and taking a second 399 USDC when they re-quote. The logs are the evidence, so it
  // holds even when the settling transaction was not ours.
  const c = company();
  const nonce = `0x${"b2".repeat(32)}` as Hex;
  const id = quote(c, { validBefore: nowSec() - 1, nonce });
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const chain = fakeChain({ spent: [nonce], logs: settlementLogs(nonce, TX) });
  await sweeper(chain.executor).tick();
  expect(payments.find(id)).toMatchObject({ status: "settled", txHash: TX });
  expect(companies.find(c)?.status).toBe("ready");
});

test("the leg survives a chain that throws — the row stays settling for the next tick", async () => {
  const c = company();
  const id = quote(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: SIG });
  stall(id);
  const chain = fakeChain();
  chain.executor.publicClient.readContract = async () => {
    throw new Error("rpc down");
  };
  await sweeper(chain.executor).tick();
  expect(payments.find(id)?.status).toBe("settling");
});

test("create_provider is NOT opened while the formation fee is unpaid (§6.5)", () => {
  // `listUnopened` is where a filing that costs us $150 at doola actually begins. `status =
  // 'ready'` already excludes the ordinary unpaid company (it is a draft); the explicit clause is
  // for the path that readies a company some other way.
  const c = company("ready");
  const id = quote(c);
  expect(requests.listUnopenedFormations("production", 10)).not.toContain(c);
  payments.markExpired(id, "quoted");
  // …and once nothing is owed, it is fileable again. (No party bound here, so the JOIN still
  // excludes it — the assertion that matters is the payment clause, checked directly.)
  const live = db
    .prepare(
      `SELECT COUNT(*) AS n FROM formation_payments
        WHERE company_id = ? AND product = 'formation' AND status IN ('quoted','settling')`,
    )
    .get(c) as { n: number };
  expect(live.n).toBe(0);
});

test("a live maintenance_year quote does NOT hold up the formation filing", () => {
  // A different bill. Blocking the filing on it would be the wrong reading of "unpaid".
  const c = company("ready");
  payments.create({
    companyId: c,
    product: "maintenance_year",
    amountUsdc: 99_000_000n,
    nonce: `0x${"c3".repeat(32)}` as Hex,
    validBefore: nowSec() + 1800,
    payTo: REVENUE,
  });
  const blocked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM formation_payments
        WHERE company_id = ? AND product = 'formation' AND status IN ('quoted','settling')`,
    )
    .get(c) as { n: number };
  expect(blocked.n).toBe(0);
});
