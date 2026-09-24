/**
 * THE CLI FUNDS THROUGH THE RECORDED PATH — the same runner, the same saga, the same rows the
 * wizard's POST /entities/:id/fund produces.
 *
 * It used to call the adapter's combined `fundTreasury` (broadcast, then await the receipt) and
 * record NOTHING until both had returned: no `submitted` row, no hash on disk before the wait, no
 * S5 outflow. That is exactly the loss #140 removed from the API path — a crash, a deploy or a lost
 * `eth_sendRawTransaction` response inside the receipt wait left an operator with a transfer that
 * had happened and no hash anywhere — and it was still open for the one door a human uses by hand.
 *
 * File-backed SQLite, like `test/workflow/fundSubmission.runner.test.ts`: the rows are the point, so
 * they are written where a restart could read them back. The chain is a fake with the three-step
 * seam (sign → send → confirm), because what is being tested is what gets written between them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HttpRequestError } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { CliContext } from "../../src/cli/context";
import { buildCli } from "../../src/cli/index";
import { BroadcastUnconfirmedError } from "../../src/errors";
import { type OutflowMeter, buildOutflowMeter } from "../../src/payments/outflowMeter";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import type { EntityRecord } from "../../src/types";

const TENANT = "0x000000000000000000000000000000000000bBbb";
const KEY = `${TENANT}:CLI Agent`;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const TREASURY = "0x0000000000000000000000000000000000000def" as const;
const PLATFORM = "0x000000000000000000000000000000000000000B" as const;
const TX = "0xfeed000000000000000000000000000000000000000000000000000000000001" as const;

const spec = {
  name: "CLI Agent",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: TENANT,
    operator: "0x000000000000000000000000000000000000cCcc",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
} as unknown as AgentSpec;

/** The documented prod condition: the broadcast response never comes back. */
const rpc429 = () =>
  new HttpRequestError({
    body: { method: "eth_sendRawTransaction" },
    details: "rate limit exceeded",
    // A key-shaped tail, because the point of the public sentence is that it never carries one.
    url: "https://arc.example.com/v2/SECRETKEY123456",
    status: 429,
  });

/** The fund half of the adapter, with the seam the saga needs: sign, send, confirm. */
function fakeArc(opts: { send?: "ok" | "throws" } = {}) {
  const arc = {
    platformAddress: PLATFORM,
    prepareFundTreasury: vi.fn(async (p: unknown) => p),
    signFundTreasury: vi.fn(async () => ({ rawTx: "0xraw01" as const, txHash: TX, nonce: 7 })),
    sendRawFundTreasury: vi.fn(async () => {
      if (opts.send === "throws")
        throw new BroadcastUnconfirmedError(TX, "fundTreasury", {
          cause: rpc429(),
        });
      return TX;
    }),
    confirmFundTreasury: vi.fn(async (txHash: typeof TX) => txHash),
    receiptOutcome: vi.fn(async () => "absent" as const),
    platformNonce: vi.fn(async () => 0),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let dir: string;
let db: Database.Database;
let repo: SqliteEntityRepository;
let outflows: OutflowMeter;

/** A bound entity with a treasury — what `fund-treasury` is pointed at. */
const bound = (): EntityRecord => ({
  idempotencyKey: KEY,
  name: spec.name,
  status: "bound",
  manager: spec.roles.manager as `0x${string}`,
  guardian: TENANT as `0x${string}`,
  operator: spec.roles.operator as `0x${string}`,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: `0x${"ab".repeat(32)}`,
  metadataURI: "https://host.example/metadata/abc",
  docPath: null,
  treasuryConfig: {
    usdc: USDC,
    payoutAddress: spec.treasury.payoutAddress as `0x${string}`,
    cap: 100_000_000n,
    period: 86_400n,
    allowlistEnabled: false,
  },
  agentId: "7",
  proxy: "0x0000000000000000000000000000000000000abc",
  treasury: TREASURY,
  createTxHash: "0xcreate1",
  bindTxHash: "0xbind1",
  fundTxHash: null,
  ownerTenantId: TENANT,
  error: null,
  specJson: JSON.stringify(spec),
});

function context(arc: ReturnType<typeof fakeArc>): CliContext {
  return {
    // Only what the fund door reads. The same shape `test/cli/jobCli.test.ts` uses: no env, no
    // chain, so the test says what the command needs rather than what a deployment happens to set.
    cfg: {
      usdc: USDC,
      maxTreasuryFund: 10_000_000n,
      maxTreasuryFundedPerTenant: 100_000_000n,
      metadataBaseUrl: "https://host.example/backend",
    } as unknown as CliContext["cfg"],
    repo,
    anchors: new SqliteOaAnchorRepository(db),
    docStore: new FileDocumentStore(join(dir, "docs")),
    arc,
    operatorSigner: { address: spec.roles.operator } as CliContext["operatorSigner"],
    jobDeps: {} as CliContext["jobDeps"],
    outflows,
  } as CliContext;
}

async function fund(arc: ReturnType<typeof fakeArc>, usd = "2.00") {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => {
    logs.push(String(m));
  });
  try {
    await buildCli(async () => context(arc)).parseAsync([
      "node",
      "legalbody",
      "fund-treasury",
      KEY,
      usd,
    ]);
  } finally {
    spy.mockRestore();
  }
  // Everything the command wrote to stdout (the ops lines included, so a leak in one of those is
  // caught too), and the command's own block — the only multi-line one — parsed.
  const block = logs.find((l) => l.startsWith("{\n"));
  return {
    stdout: logs.join("\n"),
    // The shape the command prints, in full: the assertions below compare the WHOLE block, so a
    // field added to the operator's output has to be accounted for here.
    payload: JSON.parse(block ?? "{}") as {
      key: string;
      requested: string;
      status: string;
      txHash: string | null;
      error: string | null;
    },
  };
}

const fundEvents = () =>
  repo
    .listEvents(KEY)
    .filter((e) => e.step === "fundTreasury")
    .map((e) => `${e.status}:${e.txHash ?? "-"}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "legalbody-clifund-"));
  db = openDatabase(join(dir, "state.db"));
  migrate(db);
  repo = new SqliteEntityRepository(db);
  outflows = buildOutflowMeter(db, { ceilingAtomic: 1_000_000_000n, windowMs: 3_600_000 });
  repo.claimKey(bound());
  process.exitCode = undefined;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

test("a CLI fund leaves the same trail the API path does: submitted, then funded", async () => {
  const arc = fakeArc();
  const { payload } = await fund(arc);

  // The hash was written BEFORE the receipt wait, and the settlement after it. Two rows, one hash:
  // a process killed inside the wait leaves the first one behind, which is what the sweep resolves.
  expect(fundEvents()).toEqual([`submitted:${TX}`, `funded:${TX}`]);
  const row = repo.findByIdempotencyKey(KEY)!;
  expect({ status: row.status, fundTxHash: row.fundTxHash, error: row.error }).toEqual({
    status: "funded",
    fundTxHash: TX,
    error: null,
  });
  // The saga's own S5 record, once, keyed to the transfer.
  expect(outflows.windowSum()).toBe(2_000_000n);
  // …and the transfer the operator asked for is the one that was prepared.
  expect(arc.prepareFundTreasury).toHaveBeenCalledWith({
    usdc: USDC,
    treasury: TREASURY,
    amount: 2_000_000n,
  });
  // The operator is told the hash and the verdict, not just "done" — and nothing else.
  expect(payload).toEqual({
    key: KEY,
    requested: "2.00",
    status: "funded",
    txHash: TX,
    error: null,
  });
  expect(process.exitCode).toBeUndefined();
});

test("the tenant's quota counts a CLI fund — it is not a way around the caps", async () => {
  await fund(fakeArc());
  expect(repo.sumFundedByTenant(TENANT)).toBe(2_000_000n);
});

test("a broadcast that never answers is RECORDED, not thrown as a raw RPC error", async () => {
  // The whole point of routing through the runner: the failure lands on the row, in the public
  // sentence, and the operator is told not to retry — instead of a viem stack with an RPC URL in it.
  const arc = fakeArc({ send: "throws" });
  const { stdout, payload } = await fund(arc);

  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.error).toContain("The transfer was sent (0xfeed…0001)");
  expect(row.error).toContain("Do not retry");
  expect(row.error).not.toContain("SECRETKEY123456");
  expect(stdout).not.toContain("SECRETKEY123456");
  expect(payload).toEqual({
    key: KEY,
    requested: "2.00",
    status: "bound",
    txHash: null,
    // The row's sentence and the printed one are the same string, or the operator and the wizard
    // are reading two different accounts of one transfer.
    error: row.error,
  });
  // The submission stands, with its hash: the next attempt (or the boot sweep) resolves it by
  // receipt. ⚠ And no `failed` row, which is what made a retry double-send before #140.
  expect(fundEvents()).toEqual([`submitted:${TX}`]);
  // The status is untouched — a transfer whose fate is unknown does not un-bind the entity.
  expect(row.status).toBe("bound");
  // A failed command exits non-zero, so a script does not read it as success.
  expect(process.exitCode).toBe(1);
});

test("an entity the repository does not know is a refusal, not a send", async () => {
  const arc = fakeArc();
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((m) => {
    errors.push(String(m));
  });
  try {
    await buildCli(async () => context(arc)).parseAsync([
      "node",
      "legalbody",
      "fund-treasury",
      "not-an-entity",
      "1.00",
    ]);
  } finally {
    spy.mockRestore();
  }
  expect(errors.join("\n")).toContain("not-an-entity");
  expect(arc.prepareFundTreasury).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
