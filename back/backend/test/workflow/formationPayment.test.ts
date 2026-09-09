/**
 * SETTLE, RESUME, CANCEL, RE-QUOTE (design 2026-08-26 §6.3/§6.4).
 *
 * The property every test here defends is one sentence: **a guardian is never charged twice, and
 * a payment we cannot see the outcome of is never written off.** Everything else — the CAS, the
 * persisted bytes, the `authorizationState` read, the two-step re-quote — is machinery in service
 * of it, and each is asserted against the failure it prevents rather than against its own shape.
 */
import type DatabaseType from "better-sqlite3";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CANCEL_AUTHORIZATION_TYPES } from "../../src/adapters/arc/usdcToken";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import type { FormationExecutorDeps } from "../../src/payments/formationSettle";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../../src/payments/transferAuthorization";
import {
  type CompanyRecord,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import type { Address, Hex } from "../../src/types";
import {
  type FormationPaymentDeps,
  cancelFormationPayment,
  requoteFormationPayment,
  resumeSettlingPayment,
  settleFormationPayment,
} from "../../src/workflow/formationPayment";

const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const stranger = privateKeyToAccount(`0x${"8".repeat(64)}`);
const executorAccount = privateKeyToAccount(`0x${"9".repeat(64)}`);
const TENANT = guardian.address as Address;
const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const CHAIN = 5042002;
const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);

const domain = { name: "USD Coin", version: "2", chainId: CHAIN, verifyingContract: USDC };

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let payments: SqliteFormationPaymentRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
});
afterEach(() => db.close());

/**
 * A FAKE CHAIN with the one property that matters for the B1 gate: THE SUBMITTER HAS A NONCE, and
 * a transaction whose nonce is below the account's is rejected forever ("nonce too low"). That is
 * the failure the persisted-raw-transaction scheme could not survive and the persisted
 * AUTHORIZATION does.
 *
 * `authorizationState` is a set of spent nonces, which is exactly what the token's storage is.
 */
function fakeChain(
  opts: {
    receipt?: "success" | "reverted" | "timeout";
    spent?: Set<string>;
    accountNonce?: number;
  } = {},
) {
  const sent: Hex[] = [];
  const state = {
    receipt: opts.receipt ?? "success",
    spent: opts.spent ?? new Set<string>(),
    accountNonce: opts.accountNonce ?? 7,
    /** Hashes the node ACCEPTED. A receipt exists for nothing else. */
    accepted: new Set<string>(),
  };
  const publicClient = {
    getTransactionCount: async () => state.accountNonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const nonce = decodeFakeTx(serializedTransaction).nonce;
      if (nonce < state.accountNonce) throw new Error("nonce too low");
      state.accountNonce = nonce + 1;
      sent.push(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      state.accepted.add(hash);
      return hash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (state.receipt === "timeout" || !state.accepted.has(hash))
        throw new Error("timed out waiting for receipt");
      return { status: state.receipt, gasUsed: 118_000n, transactionHash: hash };
    },
    readContract: async ({ args }: { args: unknown[] }) =>
      state.spent.has(String(args[1]).toLowerCase()),
    // biome-ignore lint/suspicious/noExplicitAny: a five-method stub of viem's PublicClient
  } as any;
  const walletClient = {
    account: executorAccount,
    signTransaction: async (tx: Record<string, unknown>) =>
      // A deterministic stand-in for a serialized transaction: the tests care that the SAME bytes
      // come back out of the row and go to the chain, not that they are RLP. Bigints are
      // stringified explicitly — JSON has none, and the real serializer has no such problem.
      `0x02${Buffer.from(
        JSON.stringify({ ...tx, account: undefined }, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).toString("hex")}` as Hex,
    // biome-ignore lint/suspicious/noExplicitAny: a two-field stub of viem's WalletClient
  } as any;
  const executor: FormationExecutorDeps = {
    publicClient,
    walletClient,
    usdc: USDC,
    chainId: CHAIN,
  };
  return { executor, sent, state };
}

/** The inverse of the stub signer below: read back what a composed transaction committed to. */
function decodeFakeTx(raw: Hex): { nonce: number; data: string } {
  return JSON.parse(Buffer.from(raw.slice(4), "hex").toString());
}

function paymentCfg(): FormationPaymentConfig {
  return {
    required: true,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    domain,
    payments,
  };
}

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

function quoteFor(c: CompanyRecord, validBefore = nowSec + 1800) {
  return payments.create({
    companyId: c.companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: `0x${"a1".repeat(32)}` as Hex,
    validBefore,
    payTo: REVENUE,
  });
}

function deps(executor: FormationExecutorDeps): FormationPaymentDeps {
  return {
    companies,
    payment: paymentCfg(),
    executor,
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
    now: () => NOW,
  };
}

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
  return (await (over.signer ?? guardian).signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: TENANT,
      to: over.to ?? REVENUE,
      value: over.value ?? row.amountUsdc,
      validAfter: 0n,
      validBefore: BigInt(over.validBefore ?? row.validBefore),
      nonce: over.nonce ?? row.nonce,
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
  const verdict = await resumeSettlingPayment(deps(recovered.executor), c, payments.find(id)!);
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
  expect(await resumeSettlingPayment(deps(recovered.executor), c, payments.find(id)!)).toBe(
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
  expect(await resumeSettlingPayment(deps(still.executor), c, payments.find(id)!)).toBe("pending");
  expect(payments.find(id)?.status).toBe("settling");
  // …and it burned an attempt, which is what makes the sweeper's backoff move.
  expect(payments.find(id)?.attempt).toBe(1);
});

test("resume expires ONLY when the window has closed AND the nonce is still unused", async () => {
  const c = company();
  const id = quoteFor(c, nowSec - 1);
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({ receipt: "timeout" });
  expect(await resumeSettlingPayment(deps(chain.executor), c, payments.find(id)!)).toBe("expired");
  expect(payments.find(id)?.status).toBe("expired");
  // Nothing was re-broadcast: the authorization is past its window and can never settle.
  expect(chain.sent).toHaveLength(0);
});

test("a SPENT nonce past the window resolves to `settled` from the receipt, never `expired`", async () => {
  // `authorizationState === true` past `validBefore` means the transfer DID happen — expiring the
  // row there would tell a guardian who paid us that they owe us again. And nothing is
  // re-broadcast: a second transaction carrying a retired authorization only reverts.
  const c = company();
  const id = quoteFor(c, nowSec - 1);
  const row = payments.find(id)!;
  const broadcastHash = `0x${"cc".repeat(32)}` as Hex;
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  payments.recordBroadcast(id, broadcastHash);
  const chain = fakeChain({ spent: new Set([row.nonce.toLowerCase()]) });
  chain.state.accepted.add(broadcastHash); // the node has it, and the receipt reads
  expect(await resumeSettlingPayment(deps(chain.executor), c, payments.find(id)!)).toBe("settled");
  expect(payments.find(id)?.status).toBe("settled");
  expect(companies.find(c.companyId)?.status).toBe("ready");
  expect(chain.sent).toHaveLength(0);
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
  expect(fresh.validBefore).toBe(Math.floor((NOW + 30 * 60 * 1000) / 1000));
});

test("a READY company has nothing left to pay for", async () => {
  const c = company("ready");
  const chain = fakeChain();
  const result = requoteFormationPayment(deps(chain.executor), c);
  expect(result).toMatchObject({ ok: false });
  expect((result as { reason: string }).reason).toMatch(/nothing left to pay/);
});

test("⚠ a SPENT nonce whose receipt we cannot read stays SETTLING — never expired", async () => {
  // The costliest wrong move available here. "The nonce is gone, so they must have cancelled, so
  // let them re-quote" is tempting and wrong: the OTHER reason a nonce is spent is that our
  // transfer landed and the receipt is merely unreadable right now (a pruned or lagging RPC).
  // Expiring would invite a second 399 USDC payment for a company already paid for.
  const c = company();
  const id = quoteFor(c, nowSec - 1);
  const nonce = payments.find(id)!.nonce;
  payments.markSettling(id, { payerAddress: TENANT, signature: `0x${"11".repeat(65)}` });
  const chain = fakeChain({ receipt: "timeout", spent: new Set([nonce.toLowerCase()]) });
  expect(await resumeSettlingPayment(deps(chain.executor), c, payments.find(id)!)).toBe("pending");
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
