/**
 * SETTLE, RESUME, CANCEL, RE-QUOTE (design 2026-08-26 §6.3/§6.4).
 *
 * The property every test here defends is one sentence: **a guardian is never charged twice, and
 * a payment we cannot see the outcome of is never written off.** Everything else — the CAS, the
 * persisted bytes, the `authorizationState` read, the two-step re-quote — is machinery in service
 * of it, and each is asserted against the failure it prevents rather than against its own shape.
 */
import type DatabaseType from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CANCEL_AUTHORIZATION_TYPES } from "../../src/adapters/arc/usdcToken";
import { quoteOf } from "../../src/formation/payment";
import type { FormationExecutorDeps } from "../../src/payments/formationSettle";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../../src/payments/transferAuthorization";
import {
  type CompanyRecord,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import type { Address, Hex } from "../../src/types";
import {
  type FormationPaymentDeps,
  advancePaymentOnChain,
  cancelFormationPayment,
  checkForDoublePayment,
  flagMineableTerminalRows,
  requoteFormationPayment,
  settleFormationPayment,
} from "../../src/workflow/formationPayment";
import {
  REVENUE,
  USDC_DOMAIN,
  cancelLog,
  fakeChain as chainWithClock,
  decodeFakeTx,
  paymentCfg,
  settlementLogs,
} from "../helpers/formationPayment";

const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const stranger = privateKeyToAccount(`0x${"8".repeat(64)}`);
const executorAccount = privateKeyToAccount(`0x${"9".repeat(64)}`);
const TENANT = guardian.address as Address;
const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);

/** The shared fixture (finding C6) — one paymentCfg, one fake chain, and the REAL pinned domain
 *  (`USDC`, not `USD Coin`, per the live probe). */
const domain = USDC_DOMAIN;

/** The shared chain, wound to THIS file's injected clock: every expiry rule here is about the
 *  relationship between a window and the block timestamp, and a fake running on the wall clock
 *  would make those tests about how long the suite took to reach them. */
const fakeChain = (opts: Parameters<typeof chainWithClock>[0] = {}) =>
  chainWithClock({ blockTimestamp: nowSec, ...opts });

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let payments: SqliteFormationPaymentRepository;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

function company(status: "draft" | "ready" = "draft"): CompanyRecord {
  const id = companies.create({
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
  return companies.find(id)!;
}

function quoteFor(c: CompanyRecord, validBefore = nowSec + 1800, ttlAt = validBefore) {
  return payments.create({
    companyId: c.companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: `0x${"a1".repeat(32)}` as Hex,
    validBefore,
    ttlAt,
    payTo: REVENUE,
  });
}

function deps(executor: FormationExecutorDeps): FormationPaymentDeps {
  return {
    companies,
    entities: repo,
    payment: paymentCfg(payments),
    executor,
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
    now: () => NOW,
  };
}

/**
 * Sign THE SERVED QUOTE (finding C1).
 *
 * `quoteOf` is the one thing in the system that builds this message, and it is what a guardian is
 * handed. A test that rebuilt the six fields by hand would pass while the product served
 * something else — which is the exact bug the single construction exists to prevent — so the
 * happy path here signs the product's own object, field for field.
 *
 * `over` is for the UNhappy paths, and each override is a deliberate divergence FROM the served
 * quote: a different signer, a different amount, a different payee.
 */
async function sign(
  c: CompanyRecord,
  over: Partial<{
    signer: typeof guardian;
    value: bigint;
    to: Address;
    validBefore: number;
    nonce: Hex;
  }> = {},
): Promise<Hex> {
  const row = payments.findLive(c.companyId, "formation")!;
  const served = quoteOf(row, TENANT, domain).typedData;
  return (await (over.signer ?? guardian).signTypedData({
    domain: served.domain,
    types: served.types,
    primaryType: served.primaryType,
    message: {
      from: served.message.from,
      to: over.to ?? served.message.to,
      value: over.value ?? BigInt(served.message.value),
      validAfter: BigInt(served.message.validAfter),
      validBefore: BigInt(over.validBefore ?? served.message.validBefore),
      nonce: over.nonce ?? served.message.nonce,
    },
  })) as Hex;
}

// ── the happy path ─────────────────────────────────────────────────────────────────────────

test("a valid signature settles: rows terminal, company READY, one broadcast", async () => {
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain();
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: true, status: "settled" });
  expect(payments.find(id)).toMatchObject({ status: "settled", payerAddress: TENANT });
  expect(companies.find(c.companyId)?.status).toBe("ready");
  expect(chain.sent).toHaveLength(1);
});

test("the AUTHORIZATION is persisted BEFORE anything is broadcast (§6.4, gate A1)", async () => {
  // The whole recovery story. Asserted by watching the row at the moment the send happens rather
  // than after: a row written afterwards would look identical at the end and be unrecoverable in
  // the middle.
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain();
  let rowAtSend: { status: string; signature: string | null } | undefined;
  const send = chain.executor.publicClient.sendRawTransaction;
  // Wrapped rather than spied: the stub is a plain object, and the point is to observe the ROW at
  // the exact instant the bytes leave — not after, where a row written late would look identical.
  chain.executor.publicClient.sendRawTransaction = async (args: {
    serializedTransaction: Hex;
  }): Promise<Hex> => {
    const row = payments.find(id)!;
    rowAtSend = { status: row.status, signature: row.signature };
    return send(args);
  };
  await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(rowAtSend?.status).toBe("settling");
  expect(rowAtSend?.signature).toBeTruthy();
});

// ── refusals: nothing reaches the chain ────────────────────────────────────────────────────

test("a signature from anyone but the GUARDIAN is refused, and nothing is broadcast", async () => {
  const c = company();
  quoteFor(c);
  const chain = fakeChain();
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c, { signer: stranger }),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  expect(chain.sent).toHaveLength(0);
});

test("`from` naming a wallet that is not the guardian is refused before any verification", async () => {
  const c = company();
  quoteFor(c);
  const chain = fakeChain();
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: stranger.address as Address,
  });
  expect(result).toMatchObject({ ok: false });
  expect((result as { reason: string }).reason).toMatch(/guardian wallet/);
  expect(chain.sent).toHaveLength(0);
});

test("an authorization for a DIFFERENT amount or a DIFFERENT payee never reaches the chain", async () => {
  const chain = fakeChain();
  const cheap = company();
  quoteFor(cheap);
  expect(
    await settleFormationPayment(deps(chain.executor), cheap, {
      signature: await sign(cheap, { value: 1n }),
      from: TENANT,
    }),
  ).toMatchObject({ ok: false, reason: "bad-signature" });

  const elsewhere = company();
  quoteFor(elsewhere);
  expect(
    await settleFormationPayment(deps(chain.executor), elsewhere, {
      signature: await sign(elsewhere, { to: stranger.address as Address }),
      from: TENANT,
    }),
  ).toMatchObject({ ok: false, reason: "bad-signature" });
  expect(chain.sent).toHaveLength(0);
});

test("⚠ a settle INSIDE THE GRACE but past the QUOTE is refused with a re-quote (gate A4)", async () => {
  // The grace exists so a signature given at the last second of the quote can still be composed,
  // broadcast and mined — not so that a NEW settlement can start inside it. The token would
  // accept this signature; we do not, and the guardian gets a fresh quote instead.
  const c = company();
  quoteFor(c, nowSec + 900, nowSec - 1);
  const chain = fakeChain();
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: false });
  expect((result as { reason: string }).reason).toMatch(/expired/);
  expect(chain.sent).toHaveLength(0);
});

test("an EXPIRED quote is refused by the clock, before anything expensive", async () => {
  const c = company();
  quoteFor(c, nowSec - 1);
  const chain = fakeChain();
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect((result as { reason: string }).reason).toMatch(/expired/);
  expect(chain.sent).toHaveLength(0);
});

test("a SECOND settle while the first is STILL SETTLING is refused — one broadcast per quote", async () => {
  // The double-charge shape in its most ordinary form: a guardian clicks twice, or reloads and
  // signs again, while the first broadcast's outcome is still unknown. The `quoted`-only CAS is
  // what stops the second signature ever reaching the chain.
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain({ receipt: "timeout" }); // the row stays `settling`
  const signature = await sign(c);
  const first = await settleFormationPayment(deps(chain.executor), c, { signature, from: TENANT });
  expect(first).toMatchObject({ ok: true, status: "pending" });
  expect(payments.find(id)?.status).toBe("settling");

  const again = await settleFormationPayment(deps(chain.executor), c, { signature, from: TENANT });
  expect(again).toMatchObject({ ok: false });
  expect((again as { reason: string }).reason).toMatch(/already being settled/);
  expect(chain.sent).toHaveLength(1);
});

// ── outcomes ───────────────────────────────────────────────────────────────────────────────

test("a REVERT is an outcome we saw: the row is `failed` and the company stays draft", async () => {
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain({ receipt: "reverted" });
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: false });
  expect(payments.find(id)?.status).toBe("failed");
  expect(companies.find(c.companyId)?.status).toBe("draft");
});

test("a TIMEOUT is NOT a failure: the row stays `settling` and the guardian is not re-quoted", async () => {
  // The single most important asymmetry in this file. A `failed` here would offer a re-quote, and
  // the original transfer could still land afterwards — a double charge caused by our impatience.
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain({ receipt: "timeout" });
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: true, status: "pending" });
  expect(payments.find(id)?.status).toBe("settling");
  expect(companies.find(c.companyId)?.status).toBe("draft");
});

// ── resume (§6.4) ──────────────────────────────────────────────────────────────────────────

test("resume re-submits THE SAME AUTHORIZATION in a freshly composed transaction", async () => {
  const c = company();
  const id = quoteFor(c);
  const stalled = fakeChain({ receipt: "timeout" });
  const signature = await sign(c);
  await settleFormationPayment(deps(stalled.executor), c, { signature, from: TENANT });
  expect(payments.find(id)!.signature).toBe(signature);

  const recovered = fakeChain();
  const verdict = await advancePaymentOnChain(deps(recovered.executor), c, payments.find(id)!);
  expect(verdict).toBe("settled");
  // A new transaction — but carrying the guardian's ORIGINAL signature, which is what the token
  // verifies. Anything else would be a second authorization, i.e. a second charge.
  expect(recovered.sent).toHaveLength(1);
  expect(decodeFakeTx(recovered.sent[0]!).data).toContain(signature.slice(2));
  expect(payments.listByCompany(c.companyId)).toHaveLength(1);
});

test("⚠ a resume settles even when another transaction consumed the submitter's nonce", async () => {
  // THE FAILURE THE PERSISTED RAW TRANSACTION COULD NOT SURVIVE (B1 gate A1). We sign at nonce 7,
  // crash before the outcome, and while we are down the submitter's nonce moves on. Re-sending
  // the old bytes is "nonce too low" forever, and the guardian's paid-for company would sit
  // unfileable until the window closed. Composing fresh takes the CURRENT nonce and lands.
  const c = company();
  const id = quoteFor(c);
  const stalled = fakeChain({ receipt: "timeout", accountNonce: 7 });
  await settleFormationPayment(deps(stalled.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });

  // …something else spends nonce 7 while we are down.
  const recovered = fakeChain({ accountNonce: 9 });
  expect(await advancePaymentOnChain(deps(recovered.executor), c, payments.find(id)!)).toBe(
    "settled",
  );
  expect(decodeFakeTx(recovered.sent[0]!).nonce).toBe(9);
  expect(payments.find(id)?.status).toBe("settled");
  expect(companies.find(c.companyId)?.status).toBe("ready");
});

test("resume does NOT expire a row whose window is still open and whose nonce is unused", async () => {
  const c = company();
  const id = quoteFor(c);
  const stalled = fakeChain({ receipt: "timeout" });
  await settleFormationPayment(deps(stalled.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  const still = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(still.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
  // …and it burned an attempt, which is what makes the sweeper's backoff move.
  expect(payments.find(id)?.attempt).toBe(1);
});

test("resume expires ONLY when the window has closed AND the nonce is still unused", async () => {
  const c = company();
  const id = quoteFor(c, nowSec - 1000);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
  // Nothing was re-broadcast: the authorization is past its window and can never settle.
  expect(chain.sent).toHaveLength(0);
});

test("⚠ the SERVER's clock alone never expires a payment — the CHAIN's does (gate A4)", async () => {
  // The token enforces `validBefore` against the BLOCK's timestamp. A box whose clock runs fast
  // would otherwise write off an authorization the chain still considers live, tell the guardian
  // to pay again, and then watch the original transfer land.
  const c = company();
  const id = quoteFor(c, nowSec - 1000);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  // The chain is still well before this window's end, whatever our clock says.
  const behind = fakeChain({ receipt: "timeout", blockTimestamp: nowSec - 5000 });
  expect(await advancePaymentOnChain(deps(behind.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
});

test("the FINALITY MARGIN holds a just-closed window open", async () => {
  // Block timestamps are a declaration, not a wall clock, and nodes disagree about the head. The
  // margin is the difference between "provably dead" and "dead by a second, on one node".
  const c = company();
  const id = quoteFor(c, nowSec - 1);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({ receipt: "timeout", blockTimestamp: nowSec + 60 });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
});

test("a QUOTE goes through the SAME procedure — no signature, no broadcast, one verdict", async () => {
  // A quoted row may have been signed in a browser we never heard back from, so it is expired on
  // the same evidence as a settling one and never on our clock alone.
  const c = company();
  const id = quoteFor(c, nowSec - 1000);
  const chain = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
  expect(chain.sent).toHaveLength(0);
});

test("a settlement in the token's LOGS resolves `settled`, past the window and all", async () => {
  // `authorizationState === true` past `validBefore` means the transfer DID happen — expiring the
  // row there would tell a guardian who paid us that they owe us again. The LOGS are what say so,
  // and nothing is re-broadcast: a second transaction carrying a retired authorization reverts.
  const c = company();
  const id = quoteFor(c, nowSec - 1000);
  const row = payments.find(id)!;
  const onChain = `0x${"ee".repeat(32)}` as Hex;
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({
    spent: new Set([row.nonce.toLowerCase()]),
    logs: settlementLogs({
      authorizer: TENANT,
      payTo: REVENUE,
      nonce: row.nonce,
      txHash: onChain,
      block: 4_000n,
    }),
  });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("settled");
  expect(payments.find(id)).toMatchObject({ status: "settled", txHash: onChain });
  expect(companies.find(c.companyId)?.status).toBe("ready");
  expect(chain.sent).toHaveLength(0);
});

test("⚠ a THIRD PARTY's settlement resolves SETTLED — never `failed` (gate A3)", async () => {
  // The bug this replaces: a signed authorization is public, so anyone holding the bytes can mine
  // it. Our own transaction then reverts with "authorization is used", and a reader that only
  // knew its own receipt wrote the payment off as FAILED — for a company whose 399 USDC is
  // sitting at the revenue address.
  const c = company();
  const id = quoteFor(c);
  const stalled = fakeChain({ receipt: "timeout" });
  await settleFormationPayment(deps(stalled.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  const row = payments.find(id)!;
  const theirs = `0x${"ab".repeat(32)}` as Hex;
  const chain = fakeChain({
    receipt: "reverted", // ours would revert, if we were foolish enough to send it
    spent: new Set([row.nonce.toLowerCase()]),
    logs: settlementLogs({
      authorizer: TENANT,
      payTo: REVENUE,
      nonce: row.nonce,
      txHash: theirs,
      block: 4_000n,
    }),
  });
  expect(await advancePaymentOnChain(deps(chain.executor), c, row)).toBe("settled");
  expect(payments.find(id)).toMatchObject({ status: "settled", txHash: theirs });
  expect(companies.find(c.companyId)?.status).toBe("ready");
  expect(chain.sent).toHaveLength(0);
});

test("an OUT-OF-BAND cancellation resolves `expired`, and the guardian may re-quote", async () => {
  // The other half of "spent but unreadable": a cancel we did not submit. The logs name it, so
  // the row does not have to sit `settling` until its window closes.
  const c = company();
  const id = quoteFor(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const row = payments.find(id)!;
  const chain = fakeChain({
    spent: new Set([row.nonce.toLowerCase()]),
    logs: [
      cancelLog({
        authorizer: TENANT,
        nonce: row.nonce,
        txHash: `0x${"cd".repeat(32)}` as Hex,
        block: 4_000n,
      }),
    ],
  });
  expect(await advancePaymentOnChain(deps(chain.executor), c, row)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
  expect(companies.find(c.companyId)?.status).toBe("draft");
  expect(requoteFormationPayment(deps(chain.executor), c)).toMatchObject({ ok: true });
});

test("an AuthorizationUsed with NO matching transfer is NOT our settlement", async () => {
  // The log says a nonce was consumed; only the Transfer says OUR payee got THIS amount. Reading
  // the first as a settlement would ready a company nobody paid for.
  const c = company();
  const id = quoteFor(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const row = payments.find(id)!;
  const chain = fakeChain({
    spent: new Set([row.nonce.toLowerCase()]),
    logs: [
      settlementLogs({
        authorizer: TENANT,
        payTo: REVENUE,
        nonce: row.nonce,
        txHash: `0x${"ef".repeat(32)}` as Hex,
        block: 4_000n,
      })[0]!,
    ],
  });
  expect(await advancePaymentOnChain(deps(chain.executor), c, row)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
  expect(companies.find(c.companyId)?.status).toBe("draft");
});

// ── cancel + re-quote ──────────────────────────────────────────────────────────────────────

test("the guardian's CancelAuthorization retires the row immediately", async () => {
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain({ receipt: "timeout" });
  await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  const cancelling = fakeChain();
  const signature = (await guardian.signTypedData({
    domain,
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization",
    message: { authorizer: TENANT, nonce: payments.find(id)!.nonce },
  })) as Hex;
  const result = await cancelFormationPayment(deps(cancelling.executor), c, { signature });
  expect(result).toMatchObject({ ok: true });
  expect(payments.find(id)?.status).toBe("expired");
});

test("a cancellation signed by anyone but the guardian is refused, and nothing is broadcast", async () => {
  // The platform cannot cancel unilaterally — the token verifies the authorizer — and neither can
  // anyone else on the guardian's behalf.
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain();
  const signature = (await stranger.signTypedData({
    domain,
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization",
    message: { authorizer: TENANT, nonce: payments.find(id)!.nonce },
  })) as Hex;
  const result = await cancelFormationPayment(deps(chain.executor), c, { signature });
  expect(result).toMatchObject({ ok: false });
  expect(chain.sent).toHaveLength(0);
  expect(payments.find(id)?.status).toBe("quoted");
});

test("RE-QUOTE is two-step: refused while anything is live, allowed once it is terminal", async () => {
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain();

  // A live quote: refused.
  expect(requoteFormationPayment(deps(chain.executor), c)).toMatchObject({ ok: false });

  // A SETTLING row: refused, and with the reason that matters — the transfer may still land.
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const mid = requoteFormationPayment(deps(chain.executor), c);
  expect(mid).toMatchObject({ ok: false });
  expect((mid as { reason: string }).reason).toMatch(/still settling/);

  // Terminal: a NEW row with a NEW nonce.
  payments.markExpired(id, "settling");
  const requoted = requoteFormationPayment(deps(chain.executor), c);
  expect(requoted).toMatchObject({ ok: true });
  const fresh = payments.findLive(c.companyId, "formation")!;
  expect(fresh.nonce).not.toBe(payments.find(id)!.nonce);
  // The QUOTE's deadline is the TTL; what the guardian signs carries the settlement grace on top.
  expect(fresh.ttlAt).toBe(Math.floor((NOW + 30 * 60 * 1000) / 1000));
  expect(fresh.validBefore).toBe(fresh.ttlAt + 15 * 60);
});

test("a READY company has nothing left to pay for", async () => {
  const c = company("ready");
  const chain = fakeChain();
  const result = requoteFormationPayment(deps(chain.executor), c);
  expect(result).toMatchObject({ ok: false });
  expect((result as { reason: string }).reason).toMatch(/nothing left to pay/);
});

test("⚠ a SPENT nonce with NO VISIBLE LOG stays SETTLING — never expired", async () => {
  // The costliest wrong move available here. "The nonce is gone, so they must have cancelled, so
  // let them re-quote" is tempting and wrong: the other reason a nonce is spent is that our
  // transfer landed and the log is merely out of view right now (a pruned or lagging endpoint).
  // Expiring would invite a second 399 USDC payment for a company already paid for.
  const c = company();
  const id = quoteFor(c, nowSec - 1);
  const nonce = payments.find(id)!.nonce;
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({ receipt: "timeout", spent: new Set([nonce.toLowerCase()]) });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
  expect(companies.find(c.companyId)?.status).toBe("draft");
});

test("a `pending` settle answers with the hash of the bytes we actually broadcast", async () => {
  // It used to answer with the row's `tx_hash` read BEFORE `markSettling` wrote it — i.e. `0x` —
  // which gives a caller nothing to look up for a transaction that is genuinely in flight.
  const c = company();
  quoteFor(c);
  const chain = fakeChain({ receipt: "timeout" });
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: true, status: "pending" });
  // keccak256 of the serialized transaction — 32 bytes — and the SAME value persisted on the row
  // before the broadcast, which is what makes a `pending` answer something a caller can look up.
  expect((result as { txHash: string }).txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect((result as { txHash: string }).txHash).toBe(
    payments.findLive(c.companyId, "formation")!.txHash,
  );
});

// ── THE DETECTOR (B1 gate A5) ───────────────────────────────────────────────────────────────
//
// Every rule in this file exists so a company cannot pay twice. That is an argument, and an
// argument is not a measurement — so we count, and say so loudly when the count is wrong.

/** An agent filed under this company — the audience for the company-level event. */
function attachAgent(c: CompanyRecord): void {
  repo.upsert({
    idempotencyKey: "t:dup",
    name: "dup",
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: TENANT,
    operator: "0x000000000000000000000000000000000000000C",
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
    ownerTenantId: TENANT,
    // biome-ignore lint/suspicious/noExplicitAny: the record type is wider than this fixture
  } as any);
  repo.attachCompany("t:dup", c.companyId);
}

/** The async twin of `opsLines`, for the passes that read a chain. */
async function opsLinesAsync(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Run something with `console.log` captured, and hand back the ops lines it wrote. */
function opsLines(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function settledRow(c: CompanyRecord, nonce: string): string {
  const id = payments.create({
    companyId: c.companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: nonce as Hex,
    validBefore: nowSec + 1800,
    payTo: REVENUE,
  });
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  payments.markSettled(id, `0x${"cc".repeat(32)}`);
  return id;
}

test("one paid row is silent — the detector says nothing about the ordinary case", () => {
  const c = company();
  settledRow(c, `0x${"a1".repeat(32)}`);
  const lines = opsLines(() => {
    expect(checkForDoublePayment({ payment: paymentCfg(payments) }, c.companyId)).toBe(false);
  });
  expect(lines.find((l) => l.opslog === "formation_payment_duplicate")).toBeUndefined();
});

test("⚠ TWO paid rows are CRITICAL, in the ops trail and in the company's own history", () => {
  const c = company();
  attachAgent(c);
  settledRow(c, `0x${"a1".repeat(32)}`);
  settledRow(c, `0x${"b2".repeat(32)}`);
  const lines = opsLines(() => {
    expect(
      checkForDoublePayment({ payment: paymentCfg(payments), entities: repo }, c.companyId),
    ).toBe(true);
  });
  expect(lines.find((l) => l.opslog === "formation_payment_duplicate")).toMatchObject({
    severity: "CRITICAL",
    companyId: c.companyId,
    paidRows: 2,
  });
  // …and on the AGENT attached to the company, because the person who needs to know is the one
  // who was charged twice.
  const events = repo.listEvents("t:dup");
  expect(events.some((e) => e.step === "formation_payment_duplicate")).toBe(true);
});

test("a REFUNDED row still counts as paid — the money was taken before it was given back", () => {
  const c = company();
  const first = settledRow(c, `0x${"a1".repeat(32)}`);
  settledRow(c, `0x${"b2".repeat(32)}`);
  payments.markRefunded(first, `0x${"fe".repeat(32)}`);
  const lines = opsLines(() => {
    expect(checkForDoublePayment({ payment: paymentCfg(payments) }, c.companyId)).toBe(true);
  });
  expect(lines.find((l) => l.opslog === "formation_payment_duplicate")).toBeTruthy();
});

test("a settle that lands on an ALREADY-PAID company trips the detector on the spot", async () => {
  const c = company();
  settledRow(c, `0x${"b2".repeat(32)}`);
  quoteFor(c);
  const chain = fakeChain();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await settleFormationPayment(deps(chain.executor), c, {
      signature: await sign(c),
      from: TENANT,
    });
  } finally {
    console.log = orig;
  }
  expect(
    lines.map((l) => JSON.parse(l)).find((l) => l.opslog === "formation_payment_duplicate"),
  ).toMatchObject({ severity: "CRITICAL", paidRows: 2 });
});

// ── EVERY EXIT IS ACCOUNTED FOR (B1 gate, finding B1) ───────────────────────────────────────
//
// The resume leg runs on a timer against a row nobody is watching. An exit that leaves the row
// EXACTLY as it found it — same status, same attempt — is an invisible loop: the sweeper asks the
// same question of the same chain every tick, forever, and the backoff never engages because
// nothing marks that a pass happened. So every non-terminal exit burns an attempt.

test("EXIT: spent nonce, no visible log → pending, and the attempt is burned", async () => {
  const c = company();
  const id = quoteFor(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const row = payments.find(id)!;
  const chain = fakeChain({ spent: new Set([row.nonce.toLowerCase()]) });
  expect(await advancePaymentOnChain(deps(chain.executor), c, row)).toBe("pending");
  expect(payments.find(id)).toMatchObject({ status: "settling", attempt: 1 });
});

test("EXIT: a settling row with NO signature → pending, and the attempt is burned", async () => {
  // Impossible by construction (`markSettling` writes the signature in the same statement), which
  // is exactly why it must not be the exit that spins silently if it ever happens.
  const c = company();
  const id = quoteFor(c);
  db.prepare("UPDATE formation_payments SET status = 'settling' WHERE payment_id = ?").run(id);
  const chain = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)).toMatchObject({ status: "settling", attempt: 1 });
});

test("EXIT: a re-broadcast whose outcome is unknown → pending, and the attempt is burned", async () => {
  const c = company();
  const id = quoteFor(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: await sign(c) });
  const chain = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)).toMatchObject({ status: "settling", attempt: 1 });
});

test("EXIT: the expiry check is REACHABLE past every earlier branch", async () => {
  // It sits behind the log verdict and the spent-nonce guard, and both of those return early. A
  // row that is genuinely dead has to be able to get through them: unknown logs, unused nonce,
  // chain clock past the window plus the margin.
  const c = company();
  const id = quoteFor(c, nowSec - 1000);
  payments.markSettling(id, { payerAddress: TENANT, signature: await sign(c) });
  const chain = fakeChain({ receipt: "timeout" });
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
});

// ── R1: THE DOUBLE CHARGE THE REVIEW FOUND (2026-09-10 verifier) ────────────────────────────
//
// The sequence, with default config and nothing unusual on the chain: the settle route broadcasts
// at submitter nonce N and waits 12 s; the transaction is underpriced and sits in the mempool, so
// the row stays `settling`. Two and a half minutes later the resume leg finds no log and an unused
// nonce, and re-broadcasts. If that re-broadcast takes the next PENDING nonce it is a SECOND
// transaction, not a replacement — and nonces are ORDERED, so N mines first and moves the money,
// then N+1 reverts with `authorization is used`. A receipt-reader marks the payment `failed`, the
// re-quote door opens, and the guardian pays 399 USDC twice for one company.

test("⚠ R1: an underpriced first attempt is REPLACED at the same nonce, not queued behind", async () => {
  const c = company();
  const id = quoteFor(c);
  const signature = await sign(c);
  // The first broadcast is accepted and then sits there: pending count moves, confirmed does not.
  const stalled = fakeChain({ receipt: "timeout", accountNonce: 7, stuckNonces: [7] });
  await settleFormationPayment(deps(stalled.executor), c, { signature, from: TENANT });
  expect(payments.find(id)).toMatchObject({ status: "settling", lastNonce: 7 });
  const firstFee = payments.find(id)!.lastMaxFeePerGas!;

  // The resume leg, against a chain where nonce 7 is STILL unconfirmed.
  const resume = fakeChain({ accountNonce: 8, stuckNonces: [] });
  resume.state.confirmedNonce = 7; // 7 is in the mempool, not in a block
  expect(await advancePaymentOnChain(deps(resume.executor), c, payments.find(id)!)).toBe("settled");
  // THE SAME NONCE, at a higher price — a replacement, not a second transaction.
  const replacement = decodeFakeTx(resume.sent[0]!);
  expect(replacement.nonce).toBe(7);
  expect(BigInt(payments.find(id)!.lastMaxFeePerGas!)).toBeGreaterThan(BigInt(firstFee));
});

test("⚠ R1: a revert on a SPENT nonce resolves SETTLED — never `failed`", async () => {
  // The tail of the same story, for the case where the second transaction went out anyway (an
  // older row, a node that dropped and re-accepted, a relayer). Ours reverts because the
  // authorization is already used, and the money is at the revenue address.
  const c = company();
  const id = quoteFor(c);
  const signature = await sign(c);
  const stalled = fakeChain({ receipt: "timeout" });
  await settleFormationPayment(deps(stalled.executor), c, { signature, from: TENANT });
  const row = payments.find(id)!;
  const theirs = `0x${"ba".repeat(32)}` as Hex;

  const reverting = fakeChain({
    receipt: "reverted",
    // The chain state our re-broadcast lands in: the nonce is spent and the transfer happened,
    // but neither was visible when the leg started.
    spent: new Set([row.nonce.toLowerCase()]),
    logs: settlementLogs({
      authorizer: TENANT,
      payTo: REVENUE,
      nonce: row.nonce,
      txHash: theirs,
      block: 4_000n,
    }),
  });
  // The pre-broadcast log read must show NOTHING, so the leg actually reaches the re-broadcast and
  // the revert — which is the path under test.
  let firstLook = true;
  const withLateLogs = { ...reverting.executor, publicClient: reverting.executor.publicClient };
  const realGetLogs = reverting.executor.publicClient.getLogs;
  // biome-ignore lint/suspicious/noExplicitAny: replacing one method on a stub client
  (withLateLogs.publicClient as any).getLogs = async (q: any) => {
    if (firstLook) {
      firstLook = false;
      return [];
    }
    return realGetLogs(q);
  };
  // …and the nonce reads unused on that first look too, so nothing short-circuits.
  let firstRead = true;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  (withLateLogs.publicClient as any).readContract = async () => {
    if (firstRead) {
      firstRead = false;
      return false;
    }
    return true;
  };

  expect(await advancePaymentOnChain(deps(withLateLogs), c, row)).toBe("settled");
  expect(payments.find(id)).toMatchObject({ status: "settled", txHash: theirs });
  expect(companies.find(c.companyId)?.status).toBe("ready");
  // ONE paid row, and the re-quote door stays shut — which is the whole point.
  expect(payments.countPaid(c.companyId)).toBe(1);
  expect(requoteFormationPayment(deps(withLateLogs), c)).toMatchObject({ ok: false });
});

test("R1: a revert with the nonce STILL UNUSED is `failed`, exactly as before", async () => {
  // The honest failure — an insufficient balance, most often. Nothing moved, so the guardian may
  // re-quote, and this is the branch that must survive the fix above.
  const c = company();
  const id = quoteFor(c);
  const chain = fakeChain({ receipt: "reverted" });
  const result = await settleFormationPayment(deps(chain.executor), c, {
    signature: await sign(c),
    from: TENANT,
  });
  expect(result).toMatchObject({ ok: false, outcome: "failed" });
  expect(payments.find(id)?.status).toBe("failed");
  expect(companies.find(c.companyId)?.status).toBe("draft");
  expect(requoteFormationPayment(deps(chain.executor), c)).toMatchObject({ ok: true });
});

test("R1: a revert on a nonce spent by a CANCELLATION expires the row", async () => {
  const c = company();
  const id = quoteFor(c);
  const row = payments.find(id)!;
  payments.markSettling(id, { payerAddress: TENANT, signature: await sign(c) });
  const chain = fakeChain({
    receipt: "reverted",
    spent: new Set([row.nonce.toLowerCase()]),
    logs: [
      cancelLog({
        authorizer: TENANT,
        nonce: row.nonce,
        txHash: `0x${"cd".repeat(32)}` as Hex,
        block: 4_000n,
      }),
    ],
  });
  // Straight through `finishSettle`: the leg's own log read would have caught the cancellation
  // first, and this asserts the branch BELOW it.
  expect(await advancePaymentOnChain(deps(chain.executor), c, payments.find(id)!)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
});

test("⚠ R1c: a WRITTEN-OFF payment whose authorization was mined anyway is flagged CRITICAL", async () => {
  // The row a paid-row COUNT can never see: `failed`, therefore not paid, therefore invisible to
  // `checkForDoublePayment` — and yet its nonce is spent, because an authorization stays mineable
  // until `validBefore` and we can only write a row off against the chain as it was at the time.
  const c = company();
  attachAgent(c);
  const id = quoteFor(c);
  const row = payments.find(id)!;
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  payments.markFailed(id);

  const chain = fakeChain({ spent: new Set([row.nonce.toLowerCase()]) });
  const lines = await opsLinesAsync(async () => {
    const flagged = await flagMineableTerminalRows(
      { ...deps(chain.executor), payment: paymentCfg(payments) },
      payments.listMineableTerminal(nowSec),
    );
    expect(flagged).toEqual([id]);
  });
  expect(lines.find((l) => l.opslog === "formation_payment_duplicate_candidate")).toMatchObject({
    severity: "CRITICAL",
    paymentId: id,
    status: "failed",
  });
  expect(
    repo.listEvents("t:dup").some((e) => e.step === "formation_payment_duplicate_candidate"),
  ).toBe(true);
});

test("R1c: a written-off row whose nonce is UNUSED is not flagged, and neither is a closed window", async () => {
  const c = company();
  const id = quoteFor(c);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  payments.markFailed(id);
  const chain = fakeChain();
  expect(
    await flagMineableTerminalRows(
      { ...deps(chain.executor), payment: paymentCfg(payments) },
      payments.listMineableTerminal(nowSec),
    ),
  ).toEqual([]);

  // …and once the window has closed the row leaves the candidate set entirely: a nonce that can
  // no longer be spent can no longer surprise us, which is what keeps this bounded.
  const old = company();
  const oldId = quoteFor(old, nowSec - 10);
  payments.markSettling(oldId, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  payments.markFailed(oldId);
  expect(payments.listMineableTerminal(nowSec).map((r) => r.paymentId)).not.toContain(oldId);
});
