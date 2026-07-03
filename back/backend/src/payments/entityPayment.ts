import { PocketGateway } from "../adapters/x402/gateway";
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { makeSignX402 } from "../adapters/x402/signX402";
import type { Config } from "../config/env";
import type { PaymentReceipt } from "../persistence/paymentIdempotencyStore";
import type { SqlitePaymentIdempotencyStore } from "../persistence/paymentIdempotencyStore";
import type { Address, EntityRecord, Hex } from "../types";
import type { AuthorityDeps, AuthorizeRequest } from "./authority";
import { authorizePayment } from "./authority";
import { buyWithX402 } from "./buyer";
import type { PaymentLedger } from "./ledger";
import { assertPublicHttpsUrl, safeFetch } from "./ssrfGuard";

/** The ArcAdapter surface this service needs — narrowed to the four treasury reads so tests can
 *  fake it without a chain. */
export interface TreasuryReader {
  treasuryAvailable(t: Address): Promise<bigint>;
  treasuryPaused(t: Address): Promise<boolean>;
  treasuryAllowlistEnabled(t: Address): Promise<boolean>;
  treasuryIsAllowed(t: Address, who: Address): Promise<boolean>;
}

export interface TreasuryStatusView {
  available: string;
  cap: string;
  paused: boolean;
  allowlistEnabled: boolean;
  /** Pocket's spendable Gateway balance (atomic USDC, 6 decimals) — what a `pay` preflight checks. */
  float: string;
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
}

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
  // Real Gateway read (used unless a test injects deps.readPocketFloat): derive this entity's pocket
  // key, build a throwaway PocketGateway, and convert its decimal available balance to atomic USDC.
  // Math.floor keeps the conversion conservative — never rounding UP into a float we don't have.
  const readPocketFloat =
    deps.readPocketFloat ??
    (async (entity: EntityRecord): Promise<bigint> => {
      const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
      const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
      const available = await gateway.getAvailable();
      return BigInt(Math.floor(available * 1e6));
    });

  const buildAuthorize = (entity: EntityRecord, treasury: Address) => {
    const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
    const signX402 = makeSignX402({
      signer: pocketSignerFromKey(pocketKey),
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
    return (req: AuthorizeRequest) => authorizePayment(authorityDeps, req);
  };

  return {
    async status(entity) {
      if (!entity.treasury) {
        return { available: "0", cap: "0", paused: false, allowlistEnabled: false, float: "0" };
      }
      const treasury = entity.treasury;
      const [available, paused, allowlistEnabled, float] = await Promise.all([
        deps.reader.treasuryAvailable(treasury),
        deps.reader.treasuryPaused(treasury),
        deps.reader.treasuryAllowlistEnabled(treasury),
        readPocketFloat(entity),
      ]);
      const cap = entity.treasuryConfig?.cap ?? 0n;
      return {
        available: available.toString(),
        cap: cap.toString(),
        paused,
        allowlistEnabled,
        float: float.toString(),
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
      const fetchImpl =
        deps.fetchImpl ??
        ((u: RequestInfo | URL, i?: RequestInit) => safeFetch(fetch, u as string, i));
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
