import {
  type CircleWalletsApi,
  circleAgentkitSigner,
  circleTypedDataSigner,
} from "../adapters/circle/circleWallets";
import type { AgentkitSigner } from "../adapters/worldid/agentkitSigner";
import { agentkitSignerFromKey, wrapFetchWithAgentkit } from "../adapters/worldid/agentkitSigner";
import { PocketGateway } from "../adapters/x402/gateway";
import { readGatewayAvailableByAddress } from "../adapters/x402/gatewayRead";
import { arcBatchingConfig, asBatchEvmSigner, pocketSignerFromKey } from "../adapters/x402/pocket";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { makeSignX402 } from "../adapters/x402/signX402";
import type { BatchEvmSigner } from "../adapters/x402/types";
import type { Config } from "../config/env";
import type { PaymentReceipt } from "../persistence/paymentIdempotencyStore";
import type { SqlitePaymentIdempotencyStore } from "../persistence/paymentIdempotencyStore";
import { usdToUnits } from "../policy/units";
import type { Address, EntityRecord, Hex } from "../types";
import type { AuthorityDeps, AuthorizeRequest, AuthorizeResult } from "./authority";
import { authorizePayment } from "./authority";
import { buyWithX402 } from "./buyer";
import type { PaymentLedger } from "./ledger";
import { providerOf, requireCircleWallets } from "./provider";
import type { SellerTrust } from "./sellerTrust";
import { assertPublicHttpsUrl, requestAwareSafeFetch } from "./ssrfGuard";
import type { StandingExposure } from "./standingExposure";
import { buildReadExposure } from "./standingExposure";

/** The ArcAdapter surface this service needs — narrowed to the four treasury reads so tests can
 *  fake it without a chain. */
export interface TreasuryReader {
  treasuryAvailable(t: Address): Promise<bigint>;
  treasuryPaused(t: Address): Promise<boolean>;
  treasuryAllowlistEnabled(t: Address): Promise<boolean>;
  treasuryIsAllowed(t: Address, who: Address): Promise<boolean>;
  usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>;
  legalStatus(proxy: Address): Promise<number>;
}

export interface TreasuryStatusView {
  available: string;
  cap: string;
  paused: boolean;
  allowlistEnabled: boolean;
  /** Pocket's spendable Gateway balance (atomic USDC, 6 decimals) — what a `pay` preflight checks. */
  float: string;
  /** Actual on-chain USDC balance of the treasury (atomic, 6 decimals) — distinct from the policy `available` leash. */
  balance: string;
  /** Honest total un-clawback-able standing exposure (operator EOA + pocket EOA + Gateway), atomic USDC,
   *  plus the configured ceiling. `float` above stays the spendable Gateway balance — this is additive. */
  standing: {
    operatorEoa: string;
    pocketEoa: string;
    gateway: string;
    total: string;
    ceiling: string;
  };
}

export interface PayArgs {
  url: string;
  amountUsdc: bigint;
  idempotencyKey: string;
  tenantId: string;
}

export interface EntityPaymentService {
  status(entity: EntityRecord): Promise<TreasuryStatusView>;
  pay(entity: EntityRecord, args: PayArgs): Promise<PaymentReceipt>;
}

export interface EntityPaymentDeps {
  reader: TreasuryReader;
  ledger: PaymentLedger;
  idempotency: SqlitePaymentIdempotencyStore;
  fetchImpl?: typeof fetch;
  /** Reads the per-agent pocket's spendable Gateway balance (atomic USDC, 6 decimals). Defaults to a
   *  real Circle Gateway read (derives the pocket key, builds a PocketGateway, converts the decimal
   *  `getAvailable()` to atomic units) — injectable so tests can fake it without a Gateway call. */
  readPocketFloat?: (entity: EntityRecord) => Promise<bigint>;
  /** Reads the per-agent standing exposure (operator EOA + pocket EOA + Gateway). Defaults to a real
   *  on-chain/Gateway read via readStandingExposure — injectable so tests can fake it without a live
   *  Gateway call. */
  readExposure?: (entity: EntityRecord) => Promise<StandingExposure>;
  /** Buyer trust dial (X402_BUYER_TRUST_POLICY): when `verified-sellers-only`, the payee must be
   *  human-backed in AgentBook before we sign anything. Absent or `open` -> today's behavior,
   *  byte-identical. See docs/design/2026-07-30-trust-policy-dials.md. */
  sellerTrust?: SellerTrust;
  /** Tier-0: Circle DevC client for circle-custody agents — their pocket key lives in Circle MPC,
   *  so x402 + AgentKit signing go through the API instead of a local key. Required only when
   *  circle-path agents exist (assertCircleCoverage enforces the boot-level pairing). */
  circleApi?: CircleWalletsApi;
}

/** Deny reasons for each non-verified seller-trust outcome (docs/design/2026-08-01-v25-batch1.md). */
const SELLER_DENY_REASONS = {
  "not-human-backed": "seller-not-human-backed",
  "not-legal-body": "seller-not-legal-body",
  "legal-body-inactive": "seller-legal-body-inactive",
  unavailable: "seller-verification-unavailable",
} as const;

/** The pocket master seed is required to derive a per-agent pocket (mirrors liveRunner.ts). */
function requireMasterSeed(cfg: Config): Hex {
  if (!cfg.pocketMasterSeed) throw new Error("set POCKET_MASTER_SEED to run payments");
  return cfg.pocketMasterSeed;
}

/** Best-effort settlement id surfaced by a resource server on success, per the x402
 *  X-PAYMENT-RESPONSE convention. Not every resource sets it, so a successful pay may still
 *  legitimately carry a null txOrTransferId. */
function extractSettlementId(res: Response): string | null {
  return res.headers.get("X-PAYMENT-RESPONSE");
}

/**
 * Per-entity payment service: composes the pocket signer, the `authorizePayment` chokepoint,
 * `buyWithX402`, the SSRF boundary, and idempotency into `{ status, pay }`. Nothing here holds
 * state across calls — each `pay`/`status` call derives the pocket key and authority fresh from
 * the passed `entity`, mirroring `buildLiveAgentRunner`'s per-run composition in liveRunner.ts.
 */
export function buildEntityPaymentService(
  cfg: Config,
  deps: EntityPaymentDeps,
): EntityPaymentService {
  // Tier-0 provider dispatch for the two pocket-signing surfaces (x402 typed-data + AgentKit
  // EIP-191). `turnkey` derives the local hot key from the master seed (unchanged); `circle`
  // signs through the Circle API against the MPC-held pocket EOA — same seams, different signer.
  const pocketSigners = (
    entity: EntityRecord,
  ): { x402: BatchEvmSigner; agentkit: AgentkitSigner } => {
    if (providerOf(entity) === "circle") {
      const api = deps.circleApi;
      if (!api)
        throw new Error(
          `entity ${entity.idempotencyKey} is on the circle custody path but no Circle client is configured (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET)`,
        );
      const wallets = requireCircleWallets(entity);
      const ref = { walletId: wallets.pocketWalletId, address: wallets.pocketAddress as Address };
      const typed = circleTypedDataSigner(api, ref);
      return {
        x402: asBatchEvmSigner({
          address: ref.address,
          signTypedData: (td) => typed.signTypedData(td),
        }),
        agentkit: circleAgentkitSigner(api, ref, cfg.chainId),
      };
    }
    const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
    return {
      x402: pocketSignerFromKey(pocketKey),
      agentkit: agentkitSignerFromKey(pocketKey, cfg.chainId),
    };
  };

  // Real Gateway read (used unless a test injects deps.readPocketFloat), atomic USDC.
  // Tier-0: a stored pocket address (backfilled fleet-wide in P1a) reads the Gateway balance BY
  // ADDRESS — key-free, so it serves both custody paths and drops the seed dependency — from the
  // SAME facilitator-API source as the key-based read (gatewayRead.ts, review finding H2), so the
  // preflight keeps seeing the balance that actually decides settlement. Legacy rows without a
  // stored address fall back to deriving the key. Math.floor keeps the decimal conversion
  // conservative — never rounding UP into a float we don't have.
  const readPocketFloat =
    deps.readPocketFloat ??
    (async (entity: EntityRecord): Promise<bigint> => {
      if (entity.pocketAddress) {
        const available = await readGatewayAvailableByAddress({
          rpcUrl: cfg.rpcUrl,
          depositor: entity.pocketAddress,
        });
        return BigInt(Math.floor(available * 1e6));
      }
      const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
      const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
      const available = await gateway.getAvailable();
      return BigInt(Math.floor(available * 1e6));
    });

  // Real standing-exposure read (used unless a test injects deps.readExposure): derive this entity's
  // pocket key, build a throwaway PocketGateway, and sum operator EOA + pocket EOA + Gateway.
  // buildReadExposure is the shared wiring also used by GET /entities/:id/treasury.
  const readExposure: (entity: EntityRecord) => Promise<StandingExposure> =
    deps.readExposure ?? buildReadExposure(cfg, deps.reader);

  const buildAuthorize = (entity: EntityRecord, treasury: Address) => {
    const signX402 = makeSignX402({
      signer: pocketSigners(entity).x402,
      chainId: cfg.chainId,
      network: arcBatchingConfig.network,
      verifyingContract: arcBatchingConfig.verifyingContract,
    });
    const authorityDeps: AuthorityDeps = {
      ledger: deps.ledger,
      entityKey: entity.idempotencyKey,
      readTreasury: async (payee: Address) => ({
        available: await deps.reader.treasuryAvailable(treasury),
        paused: await deps.reader.treasuryPaused(treasury),
        allowlistEnabled: await deps.reader.treasuryAllowlistEnabled(treasury),
        isAllowed: await deps.reader.treasuryIsAllowed(treasury, payee),
        legalActive: (await deps.reader.legalStatus(entity.proxy!)) === 0,
      }),
      signX402: async (req: AuthorizeRequest) =>
        signX402({
          payTo: req.payee,
          amount: req.amount,
          asset: req.asset,
          network: req.network,
          maxTimeoutSeconds: req.maxTimeoutSeconds,
        }),
      perTxCap: entity.perTxCap ?? undefined,
      threshold: cfg.spendAllowlistThreshold, // §14.1 — hybrid re-assert, forwarded to evaluatePolicy
    };
    const authorize = (req: AuthorizeRequest) => authorizePayment(authorityDeps, req);
    // Buyer trust dial. Runs at the authorize chokepoint — the payee is only known once the 402
    // challenge arrives, so this is the earliest point that can see it. Still strictly PRE-SIGN:
    // a denial here is a "failure before signing", the idempotency claim is released, and the same
    // key retries cleanly once the seller registers (or the World Chain RPC recovers).
    // The EFFECTIVE policy is the guardian's per-entity dial when set, else the platform default —
    // an override wins in BOTH directions (stricter or looser than the platform).
    const trust = deps.sellerTrust;
    const effective = entity.trustPolicy ?? trust?.globalPolicy ?? "open";
    if (!trust || effective === "open") return authorize;
    return async (req: AuthorizeRequest): Promise<AuthorizeResult> => {
      const outcome = await trust.verify(req.payee, effective);
      if (outcome !== "verified") return { ok: false, reason: SELLER_DENY_REASONS[outcome] };
      return authorize(req);
    };
  };

  return {
    async status(entity) {
      const ceiling = usdToUnits(cfg.maxPocketFloatUsdc).toString();
      if (!entity.treasury) {
        return {
          available: "0",
          cap: "0",
          paused: false,
          allowlistEnabled: false,
          float: "0",
          balance: "0",
          standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling },
        };
      }
      const treasury = entity.treasury;
      const [available, paused, allowlistEnabled, float, balance, exposure] = await Promise.all([
        deps.reader.treasuryAvailable(treasury),
        deps.reader.treasuryPaused(treasury),
        deps.reader.treasuryAllowlistEnabled(treasury),
        readPocketFloat(entity),
        deps.reader.usdcBalanceOf(entity.treasuryConfig?.usdc ?? cfg.usdc, treasury),
        readExposure(entity),
      ]);
      const cap = entity.treasuryConfig?.cap ?? 0n;
      return {
        available: available.toString(),
        cap: cap.toString(),
        paused,
        allowlistEnabled,
        float: float.toString(),
        balance: balance.toString(),
        standing: {
          operatorEoa: exposure.operatorEoa.toString(),
          pocketEoa: exposure.pocketEoa.toString(),
          gateway: exposure.gateway.toString(),
          total: exposure.total.toString(),
          ceiling,
        },
      };
    },

    async pay(entity, args) {
      // 1. SSRF boundary — always, synchronous, before any state (ledger/idempotency) is touched.
      try {
        assertPublicHttpsUrl(args.url);
      } catch (e) {
        return { ok: false, txOrTransferId: null, reason: `ssrf: ${(e as Error).message}` };
      }

      // 2. Treasury must be provisioned before this entity can spend.
      const treasury = entity.treasury;
      if (!treasury) {
        return { ok: false, txOrTransferId: null, reason: "treasury-not-ready" };
      }

      // 3. Pre-sign float preflight — the per-agent pocket's Gateway balance must cover the amount
      //    BEFORE any idempotency claim is made or anything is signed. On an empty float, the resource
      //    server's settle would fail non-200 after signing, caching an unsettleable "unconfirmed"
      //    receipt and permanently burning the idempotencyKey (see audit fix B-safe). Failing here
      //    instead costs nothing: no claim taken, no signature made, so the same key stays retryable.
      let float: bigint;
      try {
        float = await readPocketFloat(entity);
      } catch (e) {
        return {
          ok: false,
          txOrTransferId: null,
          reason: `float-check-failed: ${(e as Error).message}`,
        };
      }
      if (float < args.amountUsdc) {
        return { ok: false, txOrTransferId: null, reason: "insufficient-float" };
      }

      // 4. Idempotency claim — a replayed key returns the original outcome without re-settling.
      const entityKey = entity.idempotencyKey;
      const claim = deps.idempotency.begin(args.idempotencyKey, args.tenantId, entityKey);
      if (claim.status === "replayed") return claim.receipt;

      // 5. Buy: discover the price via the 402, authorize through the chokepoint, retry with X-PAYMENT.
      //    fetchImpl defaults to a safeFetch-wrapped fetch so production is SSRF-safe even if the
      //    composition root doesn't wrap it itself; tests inject their own fake fetchImpl and so
      //    bypass safeFetch (unchanged).
      // Request-aware: the AgentKit client retries with a Request OBJECT; the old `u as string`
      // cast stringified it to "[object Request]" and broke every prod pay against an
      // agentkit-enabled seller (see requestAwareSafeFetch).
      const baseFetch = deps.fetchImpl ?? requestAwareSafeFetch(fetch);
      // World layer: present a human-backing proof when the seller's 402 advertises AgentKit.
      // Sits in FRONT of buyWithX402 and only reacts to agentkit-enabled 402s — every other
      // response passes through, so sellers without the extension are unaffected. If the agent
      // is authorized within its allowance the seller returns 200 and buyWithX402 treats it as a
      // final response (no payment); otherwise the normal 402 -> policy -> sign -> settle path runs.
      let fetchImpl: typeof baseFetch;
      try {
        fetchImpl = cfg.world
          ? wrapFetchWithAgentkit(baseFetch, pocketSigners(entity).agentkit)
          : baseFetch;
      } catch (e) {
        // Signer construction failed (missing circle wallet fields / client) — nothing signed,
        // release the claim so the same key retries cleanly once the config is fixed.
        deps.idempotency.release(args.idempotencyKey, args.tenantId, entityKey);
        return { ok: false, txOrTransferId: null, reason: (e as Error).message };
      }
      // Tracks whether the payment was actually authorized/"signed" by buyWithX402's onAuthorized
      // callback. This is the load-bearing distinction for step 5 below: a failure BEFORE signing
      // (SSRF/treasury-null checks above, policy-denied, 402-no-requirements, buildAuthorize
      // construction throwing, or the first fetch throwing) is safe to release for retry. A failure
      // AFTER signing means the payment may have already been settled server-side even though our
      // confirmation leg failed — releasing the claim there would let a same-key retry sign a
      // SECOND authorization, so it must be cached instead (as an "unconfirmed" outcome) and never
      // released.
      let signed = false;
      let ledgerId: number | null = null;
      let receipt: PaymentReceipt;
      try {
        // buildAuthorize derives the pocket key and constructs the signer (derivePocketKey /
        // makeSignX402) — kept inside the try so a construction failure is caught below and the
        // idempotency claim is released for retry, instead of leaking as an unhandled rejection
        // that leaves the claim dangling (receipt_json NULL) and burns the key forever.
        const authorize = buildAuthorize(entity, treasury);
        const res = await buyWithX402(
          {
            fetchImpl,
            authorize,
            maxAmount: args.amountUsdc,
            onAuthorized: (id) => {
              signed = true;
              ledgerId = id;
            },
          },
          args.url,
        );
        if (res.status === 200) {
          receipt = { ok: true, txOrTransferId: extractSettlementId(res) };
          if (ledgerId !== null) {
            deps.ledger.markSettled(ledgerId, receipt.txOrTransferId ?? "settled");
          }
          deps.idempotency.complete(args.idempotencyKey, args.tenantId, entityKey, receipt);
          return receipt;
        }
        if (!signed) {
          deps.idempotency.release(args.idempotencyKey, args.tenantId, entityKey);
          return { ok: false, txOrTransferId: null, reason: `resource-${res.status}` };
        }
        // Signed but the confirmation leg didn't come back 200 — outcome unconfirmed. Cache (do NOT
        // release) so a same-key retry replays this instead of blindly re-signing.
        receipt = {
          ok: false,
          txOrTransferId: null,
          reason: `unconfirmed: resource-${res.status}`,
        };
        deps.idempotency.complete(args.idempotencyKey, args.tenantId, entityKey, receipt);
        return receipt;
      } catch (e) {
        const m = (e as Error).message;
        const reason = m.startsWith("policy-denied:") ? m.slice("policy-denied:".length).trim() : m;
        if (!signed) {
          deps.idempotency.release(args.idempotencyKey, args.tenantId, entityKey);
          return { ok: false, txOrTransferId: null, reason };
        }
        // Signed, then the retry leg threw (e.g. network error) — outcome unconfirmed. Cache, don't
        // release, for the same reason as above.
        receipt = { ok: false, txOrTransferId: null, reason: `unconfirmed: ${reason}` };
        deps.idempotency.complete(args.idempotencyKey, args.tenantId, entityKey, receipt);
        return receipt;
      }
    },
  };
}
