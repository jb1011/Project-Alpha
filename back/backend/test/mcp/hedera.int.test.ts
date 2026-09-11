/**
 * The three Hedera MCP tools, end to end over a real MCP client (task 5).
 *
 * Everything below runs against the SHARED scaffold (`test/helpers/hederaApp.ts`): a real
 * in-memory database with the demo entity seeded, a real `PaymentLedger` over it, a scripted
 * mirror node and scripted Arc reads. Only the mirror and the chain are fakes — the repository,
 * the ledger, the policy engine, the MCP transport and the tools themselves are the real thing,
 * because every bug this file is here to catch lives in the seams between them.
 *
 * The key vectors are IMPORTED from `test/hedera/keyDecode.test.ts` rather than copied: the two
 * suites have to agree byte for byte about what a 1-of-2 list looks like, and a second copy is a
 * second thing to get wrong. (Vitest re-registers an imported test module's own tests in this
 * file's suite, so this file reports 12 tests more than it declares.)
 */
import type Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { PaymentLedger } from "../../src/payments/ledger";
import type { EntityRecord } from "../../src/types";
import {
  A,
  B,
  ONE_OF_THREE,
  ONE_OF_TWO,
  SINGLE,
  THRESHOLD_TWO,
  TWO_OF_TWO,
} from "../hedera/keyDecode.test";
import {
  METADATA_BASE,
  TENANT,
  WEB,
  arcReads,
  fakeMirror,
  hederaApp,
  hederaDb,
} from "../helpers/hederaApp";
import { startMcpTestClient } from "./helpers";

const HEDERA_CFG = {
  network: "testnet",
  facilitatorUrl: "https://f.test",
  mirrorUrl: "https://m.test",
  usdcTokenId: "0.0.429274",
  payToAccountId: "0.0.10412694",
  verifyPriceUsdc: "0.001",
  verifyPriceAtomic: 1000n,
} as const;

const USDC = HEDERA_CFG.usdcTokenId;
const ID = `${TENANT}:FormationE2E_1`;
const OTHER_TENANT = "0x000000000000000000000000000000000000000B";
const ACCOUNT = "0.0.7162784";
const PAYEE = "0.0.800";
const NETWORK = "hedera:testnet";
const TX = "0.0.7162784@1788998489.006924053";

/** A 1-of-2 list whose second member is a 32-byte ed25519 key — design D24 is ECDSA members only.
 *  Field 2 inside the second `Key`, list length 73 (0x49), threshold-key length 77 (0x4d). */
const ONE_OF_TWO_ED25519 = `2a4d080112490a233a21${A}0a221220${"ab".repeat(32)}`;

/** A 1-of-2 holding the SAME key twice: structurally a threshold-1 pair, actually a 1-of-1 with
 *  no guardian in it. Same byte lengths as ONE_OF_TWO, since both members are 33-byte ECDSA. */
const ONE_OF_TWO_SAME_KEY = `2a4e0801124a0a233a21${A}0a233a21${A}`;

const acct = (keyHex: string | null) => ({
  account: ACCOUNT,
  keyHex,
  keyType: keyHex === null ? null : "ProtobufEncoded",
  evmAddress: null,
});

const openDbs: Database.Database[] = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
});

function setup(
  o: {
    over?: Partial<EntityRecord>;
    mirror?: Parameters<typeof fakeMirror>[0];
    /** Pre-link the entity to ACCOUNT, the way `link_hedera_account` would have. */
    link?: boolean;
    paused?: boolean;
    throws?: boolean;
    threshold?: bigint;
  } = {},
) {
  const { db, repo, rec, apiKeys } = hederaDb(o.over);
  openDbs.push(db);
  // Through the setter, never `upsert`: `upsert`'s ON CONFLICT list overwrites the Hedera columns.
  if (o.link)
    repo.setHederaLink(rec.idempotencyKey, {
      accountId: ACCOUNT,
      agentPublicKey: A,
      guardianPublicKey: B,
      linkedAt: 1_789_100_000,
    });
  const ledger = new PaymentLedger(db);
  const mirror = fakeMirror(o.mirror ?? {});
  const app = hederaApp({
    repo,
    apiKeys,
    hedera: {
      cfg: HEDERA_CFG,
      mirror,
      ledger,
      spendAllowlistThreshold: o.threshold ?? 1_000_000_000n,
    },
    legalBody: {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads({ paused: o.paused, throws: o.throws }),
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      network: "testnet" as const,
    },
  });
  const { key } = apiKeys.mint(TENANT, { capability: "spend" });
  return { db, repo, rec, ledger, mirror, app, key };
}

type App = ReturnType<typeof hederaApp>;

async function call(app: App, key: string, name: string, args: Record<string, unknown>) {
  const { client, close } = await startMcpTestClient(app, key);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await close();
  }
}

const text = (res: Awaited<ReturnType<typeof call>>) =>
  (res.content as { text: string }[])[0]!.text;
const parse = (res: Awaited<ReturnType<typeof call>>) =>
  JSON.parse(text(res)) as Record<string, unknown>;
const ledgerRows = (db: Database.Database) =>
  db.prepare("SELECT * FROM payments_ledger").all() as {
    status: string;
    payee: string;
    amount: string;
    network: string | null;
    batch_ref: string | null;
  }[];

const linkArgs = (over: Record<string, unknown> = {}) => ({
  id: ID,
  accountId: ACCOUNT,
  publicKey: A,
  ...over,
});
const policyArgs = (over: Record<string, unknown> = {}) => ({
  id: ID,
  payee: PAYEE,
  amountUsdc: "1000",
  network: NETWORK,
  ...over,
});
const reportArgs = (over: Record<string, unknown> = {}) => ({
  id: ID,
  payee: PAYEE,
  amountUsdc: "1000",
  network: NETWORK,
  transactionId: TX,
  idempotencyKey: "idem-1",
  ...over,
});

const settledTx = (
  over: { payee?: string; credit?: bigint; debit?: bigint; result?: string } = {},
) => [
  {
    transactionId: TX,
    name: "CRYPTOTRANSFER",
    result: over.result ?? "SUCCESS",
    consensusTimestamp: "1788998489.006924053",
    tokenTransfers: [
      { tokenId: USDC, account: ACCOUNT, amount: -(over.debit ?? 1000n) },
      { account: over.payee ?? PAYEE, amount: over.credit ?? 1000n },
    ],
  },
];

// ── link_hedera_account ───────────────────────────────────────────────────────────────────────

test("link_hedera_account records a 1-of-2 account and names the guardian", async () => {
  const { app, key, repo } = setup({ mirror: { account: acct(ONE_OF_TWO) } });
  expect(parse(await call(app, key, "link_hedera_account", linkArgs()))).toEqual({
    ok: true,
    accountId: ACCOUNT,
    guardianPublicKey: B,
  });
  const row = repo.findByIdempotencyKey(ID)!;
  expect(row.hederaAccountId).toBe(ACCOUNT);
  expect(row.hederaAgentPublicKey).toBe(A);
  expect(row.hederaGuardianPublicKey).toBe(B);
  expect(row.hederaLinkedAt).toBeGreaterThan(0);
});

for (const [label, keyHex] of [
  ["a single key", SINGLE],
  ["a plain 2-of-2 list", TWO_OF_TWO],
  ["a 1-of-3 threshold", ONE_OF_THREE],
  ["a 2-of-2 threshold", THRESHOLD_TWO],
  ["a 1-of-2 whose second member is ed25519", ONE_OF_TWO_ED25519],
  ["a 1-of-2 that lists the same key twice", ONE_OF_TWO_SAME_KEY],
] as const) {
  test(`link_hedera_account refuses ${label}`, async () => {
    const { app, key, repo } = setup({ mirror: { account: acct(keyHex) } });
    expect(parse(await call(app, key, "link_hedera_account", linkArgs()))).toEqual({
      ok: false,
      reason: "not-a-1-of-2-list",
    });
    expect(repo.findByIdempotencyKey(ID)!.hederaAccountId).toBeNull();
  });
}

test("link_hedera_account refuses a public key that is not one of the two", async () => {
  const { app, key, repo } = setup({ mirror: { account: acct(ONE_OF_TWO) } });
  const res = await call(
    app,
    key,
    "link_hedera_account",
    linkArgs({ publicKey: `03${"ff".repeat(32)}` }),
  );
  expect(parse(res)).toEqual({ ok: false, reason: "public-key-not-in-list" });
  expect(repo.findByIdempotencyKey(ID)!.hederaAccountId).toBeNull();
});

test("link_hedera_account refuses an account the mirror node has never seen", async () => {
  const { app, key } = setup({ mirror: { account: null } });
  expect(parse(await call(app, key, "link_hedera_account", linkArgs()))).toEqual({
    ok: false,
    reason: "account-not-found-or-hollow",
  });
});

test("link_hedera_account repeated with the same values is idempotent", async () => {
  const { app, key } = setup({ mirror: { account: acct(ONE_OF_TWO) } });
  await call(app, key, "link_hedera_account", linkArgs());
  expect(parse(await call(app, key, "link_hedera_account", linkArgs()))).toEqual({
    ok: true,
    accountId: ACCOUNT,
    guardianPublicKey: B,
  });
});

test("link_hedera_account refuses to repoint an already-linked entity", async () => {
  const { app, key, repo } = setup({ mirror: { account: acct(ONE_OF_TWO) } });
  await call(app, key, "link_hedera_account", linkArgs());
  const res = await call(app, key, "link_hedera_account", linkArgs({ accountId: "0.0.999999" }));
  expect(parse(res)).toEqual({ ok: false, reason: "already-linked" });
  expect(repo.findByIdempotencyKey(ID)!.hederaAccountId).toBe(ACCOUNT);
});

// ── check_policy ──────────────────────────────────────────────────────────────────────────────

test("check_policy refuses an entity with no linked Hedera account", async () => {
  const { app, key } = setup({ mirror: { tokenBalance: 5000n } });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: false,
    reason: "not-linked",
  });
});

test("check_policy refuses a network other than hedera:testnet", async () => {
  const { app, key } = setup({ link: true, mirror: { tokenBalance: 5000n } });
  const res = await call(app, key, "check_policy", policyArgs({ network: "eip155:5042002" }));
  expect(parse(res)).toEqual({ ok: false, reason: "unsupported-network" });
});

test("check_policy denies while the Arc treasury is paused", async () => {
  const { app, key } = setup({ link: true, paused: true, mirror: { tokenBalance: 5000n } });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: false,
    reason: "paused",
  });
});

test("check_policy denies when the treasury allowlist is on", async () => {
  const { app, key } = setup({
    link: true,
    mirror: { tokenBalance: 5000n },
    over: {
      treasuryConfig: {
        usdc: "0x0000000000000000000000000000000000000002",
        payoutAddress: "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf",
        cap: 1_000_000_000n,
        period: 86_400n,
        allowlistEnabled: true,
      },
    } as Partial<EntityRecord>,
  });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: false,
    reason: "not-allowlisted",
  });
});

test("check_policy denies above the allowlist threshold — a Hedera payee is never allowlisted", async () => {
  const { app, key } = setup({ link: true, threshold: 500n, mirror: { tokenBalance: 5000n } });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: false,
    reason: "over-threshold-needs-allowlist",
  });
});

test("check_policy denies an amount above the float balance", async () => {
  const { app, key } = setup({ link: true, mirror: { tokenBalance: 500n } });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: false,
    reason: "over-cap",
  });
});

test("check_policy allows within the float and reports it", async () => {
  const { app, key, mirror } = setup({ link: true, mirror: { tokenBalance: 5000n } });
  expect(parse(await call(app, key, "check_policy", policyArgs()))).toEqual({
    ok: true,
    available: "5000",
  });
  expect(mirror.calls).toContain(`balance:${ACCOUNT}`);
});

// ── report_payment ────────────────────────────────────────────────────────────────────────────

test("report_payment settles a confirmed transfer and writes one ledger row", async () => {
  const { app, key, db } = setup({ link: true, mirror: { transaction: settledTx() } });
  const body = parse(await call(app, key, "report_payment", reportArgs()));
  expect(body.status).toBe("settled");
  expect(typeof body.ledgerId).toBe("number");
  const rows = ledgerRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "settled",
    payee: PAYEE,
    amount: "1000",
    network: NETWORK,
  });
});

test("report_payment reported twice settles once", async () => {
  const { app, key, db } = setup({ link: true, mirror: { transaction: settledTx() } });
  await call(app, key, "report_payment", reportArgs());
  expect(parse(await call(app, key, "report_payment", reportArgs()))).toEqual({
    status: "settled",
    duplicate: true,
  });
  expect(ledgerRows(db)).toHaveLength(1);
});

test("report_payment records a consensus failure as failed with the network's own reason", async () => {
  const { app, key, db } = setup({
    link: true,
    mirror: {
      transaction: [
        {
          transactionId: TX,
          name: "CRYPTOTRANSFER",
          result: "INVALID_SIGNATURE",
          consensusTimestamp: "1788998489.006924053",
          tokenTransfers: [],
        },
      ],
    },
  });
  expect(parse(await call(app, key, "report_payment", reportArgs()))).toEqual({
    status: "failed",
    reason: "INVALID_SIGNATURE",
  });
  const rows = ledgerRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("failed");
});

test("report_payment is pending while the mirror node has nothing, and writes no row", async () => {
  const { app, key, db } = setup({ link: true, mirror: { transaction: null } });
  expect(parse(await call(app, key, "report_payment", reportArgs()))).toEqual({
    status: "pending",
  });
  expect(ledgerRows(db)).toHaveLength(0);
});

// A mismatch writes NO row: the transaction SUCCEEDED on Hedera and it is the report about it
// that is wrong, so burning the transaction id on a failed row would let one mistyped payee
// permanently block the correct report of a payment that really happened.
test("report_payment refuses a transfer that credited somebody else, and writes no row", async () => {
  const { app, key, db } = setup({
    link: true,
    mirror: { transaction: settledTx({ payee: "0.0.999" }) },
  });
  expect(parse(await call(app, key, "report_payment", reportArgs()))).toEqual({
    status: "failed",
    reason: "transfer-mismatch",
  });
  expect(ledgerRows(db)).toHaveLength(0);
});

test("report_payment refuses a transfer whose amount is not the reported one", async () => {
  const { app, key, db } = setup({
    link: true,
    mirror: { transaction: settledTx({ credit: 999n }) },
  });
  expect(parse(await call(app, key, "report_payment", reportArgs()))).toEqual({
    status: "failed",
    reason: "transfer-mismatch",
  });
  expect(ledgerRows(db)).toHaveLength(0);
});

// ── flag gating ───────────────────────────────────────────────────────────────────────────────

/** The constraint, EXECUTED rather than read off the source: the three tools are registered only
 *  where a Hedera config is. An absolute count would be a hostage to every other optional dep the
 *  scaffold leaves out, so this measures the DELTA the flag is responsible for. */
async function toolNames(app: App, key: string) {
  const { client, close } = await startMcpTestClient(app, key);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await close();
  }
}

test("the three Hedera tools exist only where a Hedera config does", async () => {
  const off = hederaDb();
  openDbs.push(off.db);
  const withoutHedera = await toolNames(
    hederaApp({ repo: off.repo, apiKeys: off.apiKeys }),
    off.apiKeys.mint(TENANT, { capability: "spend" }).key,
  );
  const { app, key } = setup();
  const withHedera = await toolNames(app, key);

  expect(withoutHedera).not.toContain("link_hedera_account");
  expect(withoutHedera).not.toContain("check_policy");
  expect(withoutHedera).not.toContain("report_payment");
  expect(withHedera).toEqual(
    [...withoutHedera, "link_hedera_account", "check_policy", "report_payment"].sort(),
  );
});

// ── tenant isolation ──────────────────────────────────────────────────────────────────────────

test("every Hedera tool is a uniform not-found on another tenant's entity", async () => {
  const { app, key } = setup({
    over: { ownerTenantId: OTHER_TENANT },
    link: true,
    mirror: { account: acct(ONE_OF_TWO), tokenBalance: 5000n, transaction: settledTx() },
  });
  for (const [name, args] of [
    ["link_hedera_account", linkArgs()],
    ["check_policy", policyArgs()],
    ["report_payment", reportArgs()],
  ] as const) {
    const res = await call(app, key, name, args);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("not found");
  }
});
