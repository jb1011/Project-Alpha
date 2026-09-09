import { randomBytes } from "node:crypto";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type TransferAuthorizationDomain,
} from "../payments/transferAuthorization";
import type {
  FormationPaymentProduct,
  FormationPaymentRecord,
  FormationPaymentRepository,
} from "../persistence/formationPaymentRepository";
import type { Address, Hex } from "../types";

/**
 * FORMATION PAYMENTS — the quote, and the shape a guardian signs (design 2026-08-26 §6.1).
 *
 * Everything here is a pure function of a payment ROW plus this deployment's pinned facts. That
 * is deliberate and it is the anti-drift rule of the whole feature: the quote a caller is shown
 * at `POST /companies`, the quote `GET /companies/:id/payment` re-serves after a page reload, and
 * the message the settle route verifies against are all THE SAME function of THE SAME row. Build
 * any one of them from live config instead and a fee change between quote and settle re-prices a
 * signature somebody already gave.
 */

/** The one product B1 quotes. `maintenance_year` is additive later (§6.8) and quotes nothing yet. */
export const FORMATION_PRODUCT: FormationPaymentProduct = "formation";

/**
 * Everything a deployment needs to quote — assembled ONCE by the composition root.
 *
 * `domain` is READ FROM THE CHAIN at boot and pinned against the token's own
 * `DOMAIN_SEPARATOR()` (see `adapters/arc/usdcToken.ts`). It travels as a value rather than as a
 * client, so every function here stays synchronous and testable: the chain read happens once, at
 * boot, on a box whose whole job then is to hand out the same four strings.
 */
export interface FormationPaymentConfig {
  /** Whether a company must be paid for before it can be filed. Everything else is inert when
   *  this is false — no row is written and no quote is ever built. */
  required: boolean;
  /** Atomic USDC (6 decimals). Copied ONTO the row at quote time and never read again for that
   *  payment: the ROW is what verification compares against. */
  feeAtomic: bigint;
  /** Whole USDC, for copy. `/config` serves this; the breakdown line ("includes the $100 Wyoming
   *  filing fee") is the interface's, because the state fee is outside doola's pack. */
  feeUsdc: number;
  /** The Ledger account. Never on `/config` — it rides the quote, on an authenticated route. */
  revenueAddress: Address;
  quoteTtlMs: number;
  /** How much longer than the quote the AUTHORIZATION stays valid (§6.4, gate A4). Absent in
   *  fixtures, where it reads as no grace at all. */
  settleGraceMs?: number;
  /**
   * The USDC token's own EIP-712 domain, read and pinned at boot — ONLY where this deployment
   * charges (finding B8).
   *
   * Optional because this whole object is now constructed everywhere, so that a deployment which
   * has STOPPED charging can still SHOW the payments it already took. Reading the token at boot is
   * right for a box that quotes (better to refuse to start than to quote a price for a signature
   * it could not settle) and wrong for one that does not: a token it cannot see would become a
   * boot failure for a feature it does not use.
   *
   * Everything that needs it is behind `required`; everything that does not is a read.
   */
  domain?: TransferAuthorizationDomain;
  /**
   * The chain head as this box last saw it, synchronously (B1 gate A3).
   *
   * A quote is written INSIDE a database transaction, so it cannot await a block number. This is
   * a cached value — refreshed at boot and on each sweeper pass — and being a little STALE is
   * harmless by construction: it is only ever used as the LOWER BOUND of the log window that
   * resolves the payment later, so an older number costs a wider scan and never a wrong answer.
   * Absent (test fixtures, a box that could not read one) simply records no hint.
   */
  chainHead?: () => bigint | null;
  /** How the cache above is kept fresh: the sweeper reads the head every pass anyway, and hands
   *  it back here rather than each surface keeping its own idea of the chain. */
  noteChainHead?: (block: bigint) => void;
  payments: FormationPaymentRepository;
}

/**
 * The quote, as a caller receives it.
 *
 * `typedData` is the whole EIP-712 request, ready for wagmi's `useSignTypedData` — rather than
 * the fields for a client to assemble. A client that builds the message itself is a second place
 * the domain, the type list and the field ORDER can be got wrong, and every one of those
 * mistakes produces a signature that verifies against nothing and reverts on-chain.
 */
export interface FormationQuote {
  paymentId: string;
  /** Atomic USDC (6 decimals), as a decimal string — JSON has no bigint. */
  amountUsdc: string;
  /** Whole USDC, for the price a human reads. */
  amountDisplayUsdc: number;
  payTo: Address;
  nonce: Hex;
  /** Always 0 (§6.1): the authorization is valid from the moment it is signed. */
  validAfter: number;
  /** Unix SECONDS — what the guardian SIGNS. It carries the settlement grace, so it is later
   *  than the countdown below; a signature given at the last second of the quote still has time
   *  to be composed, broadcast and mined. */
  validBefore: number;
  /** Unix SECONDS — WHEN THE QUOTE STOPS BEING OFFERED, and the deadline a guardian is shown.
   *  The settle door refuses past this even though the token would still accept the signature. */
  expiresAt: number;
  typedData: {
    domain: TransferAuthorizationDomain;
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
    primaryType: "TransferWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
}

/** What a caller is told about a payment that is no longer (or not yet) signable. */
export interface FormationPaymentView {
  paymentId: string;
  companyId: string;
  product: FormationPaymentProduct;
  status: FormationPaymentRecord["status"];
  amountUsdc: string;
  amountDisplayUsdc: number;
  validBefore: number;
  /** When the quote stops being offered (unix seconds) — the countdown, not the token's clock. */
  expiresAt: number;
  payerAddress: Address | null;
  txHash: Hex | null;
  refundTxHash: string | null;
  /**
   * The authorization's nonce, and the token's EIP-712 domain — ALWAYS present, including on a
   * `settling` row that deliberately carries no quote.
   *
   * They are here for exactly one caller: the guardian's CANCEL fast path, which needs to build
   * `CancelAuthorization(authorizer, nonce)` for a payment whose quote is (rightly) withheld.
   * Serving them is safe in a way serving the quote is not — a nonce and a domain cannot
   * authorize a transfer, because a transfer authorization commits to the VALUE, the RECIPIENT
   * and the WINDOW as well, and none of those is here. The worst a wrong cancel message can do is
   * produce a signature the token rejects, which leaves the payment stuck rather than moving
   * anyone's money.
   *
   * The domain is served rather than let a client assemble one, for the same reason the quote's
   * is: it is READ from the token at boot, and a client that hardcoded "USD Coin"/"2" would sign
   * cancellations against a domain the token does not verify.
   */
  nonce: Hex;
  /** NULL on a deployment that does not charge (finding B8): there is no domain to serve because
   *  the token was never read, and there is nothing live to cancel either. */
  domain: TransferAuthorizationDomain | null;
  /**
   * The signable quote — present ONLY while the row is `quoted` and still inside its window.
   *
   * Absent on a `settling` row deliberately: re-signing one is exactly the double charge §6.4
   * exists to prevent, and a client that could see a quote would offer the button.
   */
  quote?: FormationQuote;
}

/**
 * 32 random bytes, hex.
 *
 * From `randomBytes` and stored ON THE ROW — never derived from the company id. A derived nonce
 * is ONE-SHOT: the first failed attempt burns it on-chain (or merely leaves it ambiguous), and
 * the company can then never be paid for at all. The row is what makes a re-quote possible.
 */
export function newPaymentNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

/** The guardian's own wallet — the address that must sign, and the only one that may.
 *
 *  A company's `tenant_id` IS the guardian's wallet: sessions are minted by SIWE over that
 *  address, and the onboard door forces `roles.guardian` to it. So "the guardian of this company"
 *  and "the tenant that owns this company row" are the same address by construction, and this
 *  function exists to say so in one place rather than have four call sites each decide. */
export function guardianOf(company: { tenantId: string }): Address {
  return company.tenantId as Address;
}

/**
 * Build the signable quote for a `quoted` row.
 *
 * Every number the guardian signs comes off the ROW (`amount_usdc`, `nonce`, `valid_before`) and
 * every address comes from the pinned config. Nothing is read from live config, which is the
 * point: §6.3's "value == the STORED quote amount, never live config".
 */
export function quoteOf(
  payment: FormationPaymentRecord,
  guardian: Address,
  domain: TransferAuthorizationDomain,
): FormationQuote {
  const value = payment.amountUsdc.toString();
  const validBefore = String(payment.validBefore);
  return {
    paymentId: payment.paymentId,
    amountUsdc: value,
    // Derived from the ROW rather than from `cfg.feeUsdc`, so a fee change never re-prices what a
    // guardian is looking at. Exact for whole-dollar fees, which is all this ever quotes.
    amountDisplayUsdc: Number(payment.amountUsdc / 1_000_000n),
    // …and the PAYEE from the row too (B1 gate A1). `cfg.revenueAddress` is where a quote's payee
    // comes FROM, once, at insert; after that the row is the authority. An operator who rotates
    // the Ledger between quote and settle must not silently re-target a signature already given.
    payTo: payment.payTo,
    nonce: payment.nonce,
    validAfter: 0,
    validBefore: payment.validBefore,
    expiresAt: payment.ttlAt,
    typedData: {
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: guardian,
        to: payment.payTo,
        value,
        validAfter: "0",
        validBefore,
        nonce: payment.nonce,
      },
    },
  };
}

/**
 * The full payment state, with the quote attached only while it is genuinely signable.
 *
 * "Genuinely" is doing work: a `quoted` row whose `validBefore` has passed is NOT signable even
 * though the sweeper has not got to it yet, and offering its typed data would walk a guardian
 * through a wallet prompt for an authorization the token would reject. The clock is the truth;
 * the row's status is a record of when we last looked at it.
 */
export function paymentView(
  payment: FormationPaymentRecord,
  guardian: Address,
  cfg: Pick<FormationPaymentConfig, "domain">,
  nowSec: number,
): FormationPaymentView {
  // The QUOTE's clock, not the token's: past the TTL we stop offering to sign even though the
  // authorization would still be accepted for another grace period (gate A4). …And a domain: a
  // box that no longer charges can still SHOW this row, but it has nothing to sign against.
  const signable =
    payment.status === "quoted" && payment.ttlAt > nowSec && cfg.domain !== undefined;
  return {
    paymentId: payment.paymentId,
    companyId: payment.companyId,
    product: payment.product,
    status: payment.status,
    amountUsdc: payment.amountUsdc.toString(),
    amountDisplayUsdc: Number(payment.amountUsdc / 1_000_000n),
    validBefore: payment.validBefore,
    expiresAt: payment.ttlAt,
    payerAddress: payment.payerAddress,
    txHash: payment.txHash,
    refundTxHash: payment.refundTxHash,
    nonce: payment.nonce,
    domain: cfg.domain ?? null,
    ...(signable && cfg.domain ? { quote: quoteOf(payment, guardian, cfg.domain) } : {}),
  };
}

/**
 * Insert the `quoted` row for a company. Called INSIDE the caller's transaction (§6.1).
 *
 * `validBefore` is computed from `now` in SECONDS, because that is the unit EIP-3009 speaks and
 * converting it later is a rounding bug waiting for a fee to depend on it.
 */
export function insertQuote(
  cfg: Pick<
    FormationPaymentConfig,
    "feeAtomic" | "quoteTtlMs" | "payments" | "revenueAddress" | "chainHead" | "settleGraceMs"
  >,
  companyId: string,
  nowMs: number,
): string {
  const head = cfg.chainHead?.() ?? null;
  const ttlAt = Math.floor((nowMs + cfg.quoteTtlMs) / 1000);
  return cfg.payments.create({
    companyId,
    product: FORMATION_PRODUCT,
    amountUsdc: cfg.feeAtomic,
    nonce: newPaymentNonce(),
    // TWO deadlines (gate A4): the token's, which carries the grace, and the quote's.
    validBefore: ttlAt + Math.floor((cfg.settleGraceMs ?? 0) / 1000),
    ttlAt,
    // The ONE read of live config in a payment's life (B1 gate A1). Everything afterwards —
    // the served quote, local verification, the executor's calldata, the cancel message — takes
    // the payee off the row.
    payTo: cfg.revenueAddress,
    // …and the window floor for the log-based resolver (B1 gate A3).
    quotedBlock: head === null ? null : Number(head),
  });
}

/**
 * The chain-head cache behind `chainHead`/`noteChainHead`.
 *
 * A quote is written inside a database transaction and cannot await a block number, so the head
 * is read asynchronously (at boot, and on every sweeper pass) and read back synchronously here.
 * Staleness is harmless BY CONSTRUCTION: the value is only ever the lower bound of a log window,
 * so an old number costs a wider scan and can never produce a wrong verdict.
 */
export function newChainHeadCache(initial: bigint | null = null): {
  get: () => bigint | null;
  set: (block: bigint) => void;
} {
  let value = initial;
  return {
    get: () => value,
    // MONOTONIC: a reorg or a lagging endpoint must not walk the floor forwards past a block a
    // quote was issued at, which would start its window after its own settlement.
    set: (block: bigint) => {
      if (value === null || block > value) value = block;
    },
  };
}
