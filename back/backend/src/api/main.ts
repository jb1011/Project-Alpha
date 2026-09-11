import "dotenv/config";
import { serve } from "@hono/node-server";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import {
  CONTROLLER_GRANTED_SELECTORS,
  CONTROLLER_PINNED_SELECTORS,
  assertControllerWiring,
  assertLegacyFactoryOwner,
} from "../adapters/arc/bootVerify";
import {
  managerAccount,
  managerWalletClient,
  platformManagerAddress as platformManagerAddressOf,
  publicClientFor,
  walletClientForKey,
} from "../adapters/arc/clients";
import { readUsdcDomain } from "../adapters/arc/usdcToken";
import { withCircleRateLimit } from "../adapters/circle/circleRateLimit";
import {
  activateCircleSca,
  buildCircleWalletsApi,
  circleOperatorSigner,
  provisionCircleWallets,
} from "../adapters/circle/circleWallets";
import { buildDoolaApi } from "../adapters/doola/doolaClient";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { type GuardianPasskey, provisionAgentVault } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { createAgentBookRegistrar } from "../adapters/worldid/agentBookRegistrar";
import { arcBatchingConfig } from "../adapters/x402/pocket";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { SqliteNonceStore } from "../auth/nonceStore";
import {
  WORLD_CHAIN_DEFAULTS,
  canFormEntities,
  canProvisionTurnkey,
  canRegisterAgentBook,
  loadConfig,
} from "../config/env";
import { resolveFormationDeployment } from "../formation";
import { createCompany } from "../formation/company";
import { newChainHeadCache } from "../formation/payment";
import { formationSummary } from "../formation/status";
import { HederaMirror } from "../hedera/mirror";
import { buildJobDeps } from "../jobs/composition";
import { opsLog } from "../observability/opsLog";
import { AGENT_BOOK_CAIP2, createAgentBookReader } from "../payments/agentBookReader";
import { buildEntityPaymentService } from "../payments/entityPayment";
import { LOW_SUBMITTER_BALANCE_WEI } from "../payments/formationSettle";
import { PaymentLedger } from "../payments/ledger";
import { createLegalBodyResolver } from "../payments/legalBody";
import { buildOutflowMeter } from "../payments/outflowMeter";
import { buildPocketFunding } from "../payments/pocketFunding";
import { buildSellerTrust } from "../payments/sellerTrust";
import { buildReadExposure } from "../payments/standingExposure";
import { SqliteAgentBookRepository } from "../persistence/agentBookRepository";
import { SqliteAgentRunStore } from "../persistence/agentRunStore";
import { SqliteApiKeyStore } from "../persistence/apiKeyStore";
import { SqliteBridgeLegRepository } from "../persistence/bridgeLegRepository";
import { SqliteChallengeStore } from "../persistence/challengeStore";
import { SqliteCompanyRepository } from "../persistence/companyRepository";
import { migrate, openDatabase } from "../persistence/db";
import { SqliteDocumentIndexRepository } from "../persistence/documentIndexRepository";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteDoolaEventRepository } from "../persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../persistence/formationRepository";
import { SqliteLinkCodeStore } from "../persistence/linkCodeStore";
import { SqliteOaAnchorRepository } from "../persistence/oaAnchorRepository";
import { SqlitePasskeyStore } from "../persistence/passkeyStore";
import { SqlitePaymentIdempotencyStore } from "../persistence/paymentIdempotencyStore";
import {
  assertCircleCoverage,
  assertPaymentAddressSeparation,
  assertTurnkeyCoverage,
  backfillPocketAddresses,
} from "../persistence/tier0";
import { SqliteWorldStore } from "../persistence/worldStore";
import { usdToUnits } from "../policy/units";
import type { Address } from "../types";
import { TaskTracker } from "../util/taskTracker";
import { reconcileAgentBook } from "../workflow/agentBookReconcile";
import { processDoolaEvent } from "../workflow/formationProcessor";
import { FormationSweeper } from "../workflow/formationSweeper";
import { runOnboarding } from "../workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../workflow/runner";
import { buildApiApp } from "./app";
import { ApiError } from "./errors";
import { TokenBucket } from "./routes/agentBook";
import { buildWorldIdDeps } from "./routes/worldId";
import { buildX402DemoDeps } from "./routes/x402Demo";
import { installShutdownHandlers, shouldInstallSignalHandlers } from "./shutdown";

async function main() {
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required to run the API server");
  // Turnkey is now per-deployment (mirror of circle): a deployment shipping no TURNKEY_* is
  // turnkey-less by construction — the circle-only mainnet shape. The DB-coverage assert below
  // still refuses to boot if turnkey-custody agents exist that this deployment can't serve.
  const turnkeyServiceable = canProvisionTurnkey(cfg);
  if (cfg.turnkey && !turnkeyServiceable)
    console.warn(
      "[boot] TURNKEY_* core config is set but the delegated keypair is missing — per-agent vault provisioning is DISABLED (turnkeyCustodyAvailable=false). If this deployment should serve turnkey custody, set TURNKEY_DELEGATED_API_{PUBLIC,PRIVATE}_KEY.",
    );

  const db = openDatabase(cfg.dbPath);
  migrate(db);
  // Tier-0: refuse to boot with unserviceable circle-path agents; store pocket addresses once
  // so read paths can stop deriving from the master seed (spec audit items 1 + 7).
  assertCircleCoverage(db, cfg.circle);
  assertTurnkeyCoverage(db, turnkeyServiceable);
  if (cfg.pocketMasterSeed) backfillPocketAddresses(db, cfg.pocketMasterSeed);
  // ...and, AFTER the pocket backfill so every derived address is a row this can see: the DB half
  // of the payment-address separation invariants (2026-08-26 §6.6, B1 gate A2). env.ts checks the
  // fixed key set; only the database knows the fleet's operator and pocket addresses. A no-op on
  // every deployment that does not charge.
  // `formation` is optional in the TYPE only (test fixtures build Config literals); loadConfig
  // always populates it, and a fixture that does not simply has no payment to separate.
  if (cfg.formation) assertPaymentAddressSeparation(db, cfg.formation.payment);
  const repo = new SqliteEntityRepository(db);
  // Same db handle as `repo`, deliberately: the v1 anchor row is written INSIDE the entity row's
  // transaction at create-confirm, so the entity store and the anchor history can never disagree
  // about what the chain holds.
  const anchors = new SqliteOaAnchorRepository(db);
  // Same db handle again: the four formation step rows are claimed inside one transaction, the
  // spend-control counts JOIN `entities`, and the party bind commits with the entity claim.
  const formationRequests = new SqliteFormationRepository(db);
  const formationParties = new SqliteFormationPartyRepository(db);
  // Always constructed, credentials or not: `companies` is plain SQL over the same database, and
  // a box that has lost its doola block must still describe (and serve documents for) the filings
  // it already made.
  const companies = new SqliteCompanyRepository(db);
  // Same db handle, and for the sharpest version of the reason: the `quoted` row is inserted in
  // the SAME TRANSACTION as the company it belongs to (§6.1), so a second handle would make that
  // impossible to express. Always constructed, like `companies` and for the same reason — a box
  // that stops charging must still be able to read the payments it already took.
  const formationPayments = new SqliteFormationPaymentRepository(db);
  // Same db handle again: a stored document's index row and the step it confirms have to commit
  // against the same database, and the webhook ledger is the sweeper's work queue.
  const formationDocuments = new SqliteDocumentIndexRepository(db);
  const doolaEvents = new SqliteDoolaEventRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);
  const nonceStore = new SqliteNonceStore(db);
  const apiKeys = new SqliteApiKeyStore(db);
  const passkeys = new SqlitePasskeyStore(db);
  const challenges = new SqliteChallengeStore(db);
  const agentRuns = new SqliteAgentRunStore(db);
  // One account object for the whole boot: the executor/signing identity, used by the on-chain
  // verification below and by the ENS apex fallback further down.
  const executor = managerAccount(cfg);
  const publicClient = publicClientFor(cfg);
  const factoryAddress = cfg.factoryAddress as Address;

  // Boot-time on-chain verification (design §5). loadConfig can only check the env against itself;
  // these are the relational facts that live on the chain, and every one of them otherwise fails at
  // the first onboarding instead of at boot. See adapters/arc/bootVerify.ts.
  if (cfg.controllerAddress) {
    await assertControllerWiring(publicClient, {
      controller: cfg.controllerAddress,
      factory: factoryAddress,
      identityRegistry: cfg.identityRegistry,
      executor: executor.address,
    });
    console.log(
      `[boot] controller wiring verified on-chain: factory owner, ${CONTROLLER_GRANTED_SELECTORS.length} executor grants, ${CONTROLLER_PINNED_SELECTORS.length} registry pins`,
    );
  } else {
    await assertLegacyFactoryOwner(publicClient, {
      factory: factoryAddress,
      signer: executor.address,
    });
  }

  const arc = new ArcAdapter({
    publicClient,
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: factoryAddress,
    identityRegistry: cfg.identityRegistry,
    controller: cfg.controllerAddress,
  });
  const operatorSigner = await buildOperatorSigner(cfg);
  // S5: the platform-wide outflow brake — one meter, shared by every path in this process.
  const outflows = buildOutflowMeter(db, {
    ceilingAtomic: cfg.platformOutflowCeiling,
    windowMs: cfg.platformOutflowWindowMs,
  });
  // Tier-0: one rate-limited Circle client for every circle-custody surface in this process
  // (signing, funding bridge, job ops). Undefined on turnkey-only deployments — every consumer
  // fails with a named error if a circle-path agent appears without it (assertCircleCoverage
  // already refuses boot for that pairing).
  const circleApi = cfg.circle ? withCircleRateLimit(buildCircleWalletsApi(cfg.circle)) : undefined;
  const bridgeLegs = new SqliteBridgeLegRepository(db);
  // Audit fix C: the platform manager address, force-set into `roles.manager` on onboarding so an
  // agent-first caller never needs to know or guess it (see managerAccount doc).
  // NoviController (design §5): in controller mode this is the CONTROLLER contract — the signing
  // key above stays the executor/tx sender only. Unset => the signing key's address, as before.
  const platformManagerAddress = platformManagerAddressOf(cfg);
  if (cfg.controllerAddress)
    console.warn(
      `⚠ NoviController mode: manager identity = ${platformManagerAddress}, executor (signing key) = ${executor.address}, factory = ${factoryAddress}`,
    );

  // The ONE resolver for "is this address a Novi legal body in good standing?" (design
  // 2026-09-10 D1): built once, here, from the repository and the SAME two Arc reads the buyer
  // dial has always used, and shared by every surface that asks the question — the buyer dial
  // below today, the public lookup and the `legal-bodies-only` seller policy next. It holds no
  // state and caches nothing (D8), so sharing it costs nothing and guarantees that a suspension
  // means the same thing to every caller.
  // The public lookup (D3) receives THIS instance below, as `deps.legalBody.resolver`.
  const legalBody = createLegalBodyResolver({
    // Payer-keyed (D2): an AgentKit proof carries the pocket, not the treasury.
    findByPocketAddress: (addr) => repo.findByPocketAddress(addr),
    findByTreasury: (addr) => repo.findByTreasury(addr),
    legalStatus: (proxy) => arc.legalStatus(proxy),
    treasuryPaused: (treasury) => arc.treasuryPaused(treasury),
  });

  /**
   * The Hedera rail (design 2026-09-10), present exactly when HEDERA_ENABLED produced a whole
   * `cfg.hedera` block. Absent, the three MCP tools are not registered at all.
   *
   * `spendAllowlistThreshold` is COPIED from the same config field `entityPayment.ts` forwards to
   * `evaluatePolicy` for Arc, so one deployment cannot end up with two hybrid thresholds. The
   * ledger is a second handle on the SAME database — `PaymentLedger` holds no state of its own.
   */
  const hedera = cfg.hedera
    ? {
        cfg: cfg.hedera,
        mirror: new HederaMirror(cfg.hedera.mirrorUrl),
        ledger: new PaymentLedger(db),
        spendAllowlistThreshold: cfg.spendAllowlistThreshold,
      }
    : undefined;

  // Per-entity payment service (treasury_status/pay tools) needs a pocket-derivation seed; leave
  // it undefined on deployments that haven't set POCKET_MASTER_SEED so they keep working (the
  // tools then return "payments unavailable" instead of failing to boot).
  const payments = cfg.pocketMasterSeed
    ? buildEntityPaymentService(cfg, {
        reader: arc,
        ledger: new PaymentLedger(db),
        idempotency: new SqlitePaymentIdempotencyStore(db),
        // Buyer trust dial (X402_BUYER_TRUST_POLICY, default "open" = no-op): when strict, the
        // payee must be human-backed in AgentBook before anything is signed. Works without any
        // WORLD_* portal creds — the reader only needs the World Chain RPC + AgentBook address,
        // both of which have defaults. docs/design/2026-07-30-trust-policy-dials.md
        sellerTrust: buildSellerTrust({
          globalPolicy: cfg.x402BuyerTrustPolicy,
          store: new SqliteWorldStore(db),
          reader: createAgentBookReader({
            rpcUrl: cfg.worldChain?.rpcUrl ?? WORLD_CHAIN_DEFAULTS.rpcUrl,
            contractAddress: cfg.worldChain?.agentBook ?? WORLD_CHAIN_DEFAULTS.agentBook,
          }),
          // Legal-bodies tier: the shared resolver above — the same instance, and therefore the
          // same definition of standing, that the public lookup and the seller policy use.
          legalBody,
        }),
        circleApi,
      })
    : undefined;

  // Explicit treasury->pocket top-up (fund_pocket tool/route). Guard: the turnkey path needs
  // POCKET_MASTER_SEED + Turnkey config; the circle path needs only the Circle client — either
  // combination makes the tool available, and the per-entity dispatch names what's missing.
  const pocketFunding =
    (cfg.pocketMasterSeed && cfg.turnkey) || circleApi
      ? buildPocketFunding(
          cfg,
          outflows,
          circleApi ? { api: circleApi, legs: bridgeLegs } : undefined,
        )
      : undefined;

  // S2 standing-float-ceiling reads for the dashboard (GET /entities/:id/treasury). Same guard as
  // `payments`: undefined when POCKET_MASTER_SEED isn't configured, in which case the route
  // reports zeroed standing instead of failing to boot.
  const standingExposure = cfg.pocketMasterSeed
    ? {
        read: buildReadExposure(cfg, arc),
        ceilingAtomic: usdToUnits(cfg.maxPocketFloatUsdc).toString(),
      }
    : undefined;

  // Both seams are optional in the saga; on a turnkey-less deployment they stay undefined and the
  // onboard gates (REST + MCP) refuse `custody: "turnkey"` before any claim, while
  // assertTurnkeyCoverage above guarantees no existing row can need them.
  const provision = turnkeyServiceable
    ? (p: { subOrgName: string; guardianPasskey: GuardianPasskey; guardianEmail?: string }) =>
        provisionAgentVault(buildTurnkeyProvisionDeps(cfg), {
          ...p,
          delegatedApiPublicKey: cfg.turnkey!.delegatedApiPublicKey!,
        })
    : undefined;
  const signerForEntity = turnkeyServiceable
    ? (e: { subOrgId: string; operator: string }) => TurnkeySigner.forEntity(cfg, e)
    : undefined;

  // Tier-0 custody wiring. `ARC-TESTNET` is the Circle blockchain enum for chain 5042002 (the
  // only chain this deployment targets); mainnet lands with its own enum in P4.
  const CIRCLE_BLOCKCHAIN = "ARC-TESTNET";
  const circleWalletSetId = cfg.circle?.walletSetId;
  const provisionCircle =
    circleApi && circleWalletSetId
      ? async ({ entityKey }: { entityKey: string; name: string }) => {
          const { operator, pocket } = await provisionCircleWallets(circleApi, {
            walletSetId: circleWalletSetId,
            blockchain: CIRCLE_BLOCKCHAIN,
            entityKey,
          });
          // P2 probe A: Circle refuses ANY signature from an undeployed SCA, and the saga's next
          // SCA touch is the bind SIGNATURE — deploy it now with one sponsored no-op (~0.009
          // USDC, ~3s; probe B). Runs BEFORE the record persists, so a crash re-provisions
          // cleanly (documented orphan trade-off) rather than stranding an unactivated SCA.
          await activateCircleSca(circleApi, {
            operatorWalletId: operator.walletId,
            entityKey,
            usdc: cfg.usdc,
            gatewayWallet: arcBatchingConfig.verifyingContract,
            outflows,
          });
          return {
            operator: operator.address,
            operatorWalletId: operator.walletId,
            pocketWalletId: pocket.walletId,
            pocketAddress: pocket.address,
            walletSetId: circleWalletSetId,
          };
        }
      : undefined;
  const circleSignerForEntity = circleApi
    ? (e: { operatorWalletId: string; operator: string }) =>
        circleOperatorSigner(circleApi, { walletId: e.operatorWalletId, address: e.operator })
    : undefined;
  // Creation-time pocket address for turnkey/legacy agents (audit item 7 — new rows must not
  // re-open the master-seed read dependency the P1a backfill closed).
  const derivePocketAddress = cfg.pocketMasterSeed
    ? (entityKey: string) =>
        privateKeyToAccount(derivePocketKey(cfg.pocketMasterSeed!, entityKey)).address
    : undefined;

  // doola formation (design §2). ONE value, resolved once by the shared resolver every
  // composition root uses (api, cli, legacy onboarding server), and handed to BOTH the claim
  // (runner) and the saga — so the pin on a row and the client that would file for it can never
  // come from different places, and no door can pin differently from another. Null on a
  // credential-less deployment, and on one that has FORMATION_REQUIRED off = stub mode.
  const formationDeployment = resolveFormationDeployment(cfg);
  // Built from the SAME config block `canFormEntities` gates on, so the availability the door
  // advertises and the client that would actually file can never disagree.
  const doolaApi = cfg.doola
    ? buildDoolaApi({
        apiKey: cfg.doola.apiKey,
        baseUrl: cfg.doola.baseUrl,
        environment: cfg.doola.environment,
      })
    : undefined;
  if (doolaApi)
    console.warn(
      `⚠ doola formation ENABLED (${cfg.doola!.environment}, required=${cfg.formation?.required})`,
    );
  // C5. The opt-in shape, said out loud at boot. It is the shape the testnet box runs until the
  // PR-4 wizard collects a legal identity, and it is easy to mistake for "formation is off": the
  // credentials are loaded, the door advertises the capability, the receiver is mounted — and yet
  // an onboard that carries no partyId files nothing at all, forever. An operator who expected
  // every new entity to become a Wyoming LLC should learn that here, not from an empty
  // `formation_requests` table a week later.
  if (doolaApi && !cfg.formation?.required)
    console.warn(
      "⚠ FORMATION_REQUIRED=false — formation is AVAILABLE, not mandatory: an onboard is only pinned and filed when it carries a companyId, and the wizard offers a Skip that sends none (docs/runbooks/doola-deploy.md)",
    );

  const worldStore = new SqliteWorldStore(db);
  // ONE builder (§6.7). Spelled out inline here, this object silently dropped
  // `maxCompaniesPerHuman` — so the company ceiling the boot invariant demands for production
  // formation had no production caller at all.
  const worldId = cfg.world ? buildWorldIdDeps(cfg.world, worldStore) : undefined;
  if (worldId)
    console.warn(
      `⚠ World ID guardian gate ENABLED (action ${worldId.cfg.action}, env ${worldId.cfg.environment}, enforce=${worldId.requireGuardian})`,
    );
  if (worldId?.cfg.attestAction)
    console.warn(
      `⚠ Identity attestation step-up ENABLED (action ${worldId.cfg.attestAction}, min age ${worldId.attestMinAge})`,
    );

  // `loadConfig` always populates this block — zod supplies every default — and the type is
  // optional only so a test fixture can build a Config literal without it. Named once so no call
  // site below re-invents a default the config already owns.
  const formationCfg = cfg.formation!;

  /**
   * The `createCompany` dependency set, built ONCE (design §7).
   *
   * THREE doors call `createCompany` — REST `POST /companies`, MCP `create_company` and the A1
   * onboard shim — and each of them used to spell this object out for itself, complete with its
   * own `?? 3` / `?? 10` fallbacks for limits zod has already defaulted. Three literals is three
   * ways for the surfaces to disagree about what a company costs, which is the exact drift the
   * one domain function exists to prevent. Only `transaction` differs per call site: the shim
   * already runs inside the claim's transaction, the two doors open their own.
   */
  /**
   * FORMATION PAYMENTS (§6.1) — assembled ONCE, and only where this deployment charges.
   *
   * The USDC EIP-712 domain is READ FROM THE CHAIN HERE, at boot, and pinned against the token's
   * own `DOMAIN_SEPARATOR()` (`readUsdcDomain` throws otherwise). Once, because it is four
   * constants about somebody else's predeploy: reading it per quote would put a chain round trip
   * — and a way to fail — on the hot path of every company creation, and hardcoding it would
   * produce signatures that revert only after a guardian has approved them.
   *
   * A box that cannot read the token therefore does not boot. That is the right direction: the
   * alternative is booting a deployment that will quote a price for a signature it cannot settle.
   */
  // The chain head, read once here and refreshed by the sweeper. Recorded on every quote as the
  // floor of the log window that resolves it later (B1 gate A3).
  const chainHead = newChainHeadCache(
    formationCfg.payment.required ? await publicClient.getBlockNumber().catch(() => null) : null,
  );
  /**
   * ALWAYS CONSTRUCTED (finding B8), and `required` inside it is the switch.
   *
   * It used to exist only where the deployment charges, which made every payment surface vanish
   * with the flag — including the READ ones. Turn charging off after taking money and the
   * settled rows become invisible: a guardian who paid 399 USDC sees no payment at all, and
   * support has nothing to point at. Rolling a flag back must not erase history.
   *
   * The DOMAIN is the one part that stays conditional: reading the token at boot is right for a
   * box that quotes (better to refuse to start than to quote a price for a signature it could not
   * settle) and wrong for one that does not, where a token it cannot see would be a boot failure
   * for a feature it does not use.
   */
  const formationPayment = {
    required: formationCfg.payment.required,
    feeAtomic: formationCfg.payment.feeAtomic,
    feeUsdc: formationCfg.payment.feeUsdc,
    // Non-null WHEN REQUIRED, by the boot invariant in env.ts; the empty string is never read on
    // a deployment that does not charge, because nothing quotes.
    revenueAddress: (formationCfg.payment.revenueAddress ?? "0x") as Address,
    quoteTtlMs: formationCfg.payment.quoteTtlMs,
    settleGraceMs: formationCfg.payment.settleGraceMs,
    domain: formationCfg.payment.required
      ? await readUsdcDomain(publicClient, cfg.usdc, cfg.chainId)
      : undefined,
    chainHead: chainHead.get,
    noteChainHead: chainHead.set,
    payments: formationPayments,
  };
  if (formationPayment.required)
    console.warn(
      `⚠ FORMATION PAYMENTS ENABLED: $${formationPayment.feeUsdc} USDC to ${formationPayment.revenueAddress} (USDC domain "${formationPayment.domain?.name}" v${formationPayment.domain?.version}, pinned on-chain)`,
    );

  /**
   * THE SETTLE SUBMITTER's clients (B1 gate A2) — a DEDICATED EOA, not the platform key.
   *
   * `managerWalletClient` was the obvious choice and the wrong one. The platform key signs
   * registry writes, sweeps and job transactions, so sharing it means sharing a NONCE SPACE: a
   * guardian's settle can be starved or replaced by traffic that has nothing to do with them,
   * while they watch a spinner. It also means the gas float for settlements is not a number
   * anyone can look at. And it hands a gas-only job the factory owner's authority.
   *
   * So: its own key, its own nonce, its own USDC balance (on Arc the gas token IS USDC), and no
   * role anywhere else — enforced at boot by the invariants in `config/env.ts`, which refuse a
   * submitter that collides with the platform key, the revenue address or any other signer.
   */
  const formationExecutor = formationCfg.payment.submitterKey
    ? {
        publicClient,
        walletClient: walletClientForKey(cfg, formationCfg.payment.submitterKey),
        usdc: cfg.usdc,
        chainId: cfg.chainId,
      }
    : undefined;
  if (formationPayment.required && formationExecutor) {
    const submitter = formationExecutor.walletClient.account?.address as Address;
    // The gas float, read once and stated. It is USDC on Arc, so "low" is a number an operator
    // can act on directly — and a submitter that runs dry does not fail a settle loudly, it
    // leaves rows `settling` until somebody notices.
    const balance = await publicClient.getBalance({ address: submitter }).catch(() => null);
    console.warn(
      `⚠ FORMATION SETTLE SUBMITTER: ${submitter} (gas balance ${balance ?? "unknown"})`,
    );
    if (balance !== null && balance < LOW_SUBMITTER_BALANCE_WEI)
      console.warn(
        `⚠ FORMATION SETTLE SUBMITTER IS LOW ON GAS (${balance}) — top ${submitter} up with USDC, or settles will stall with guardians' authorizations already signed`,
      );
  }

  const companyDeps = formationDeployment
    ? {
        companies,
        parties: formationParties,
        requests: formationRequests,
        pin: formationDeployment,
        sandboxSyntheticPii: formationCfg.sandboxSyntheticPii,
        maxPerTenant: formationCfg.maxPerTenant,
        dailyCeiling: formationCfg.dailyCeiling,
        // The SSN keyring (§4.2). Absent everywhere except production doola, where it is a boot
        // invariant — and its absence makes the door REFUSE the field, never store it in clear.
        pii: formationCfg.pii,
        world: worldId,
        // With payment on, `createCompany` lands the company `draft` and writes its quote in the
        // same transaction. Absent = the beta shape, where every company lands `ready`.
        payment: formationPayment,
      }
    : undefined;

  const runSaga: RunSaga = (i) =>
    runOnboarding({
      spec: i.spec,
      idempotencyKey: i.idempotencyKey,
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: cfg.usdc,
      metadataBaseUrl: cfg.metadataBaseUrl,
      ensParentName: cfg.ens?.parentName,
      ownerTenantId: i.tenantId,
      specJson: i.specJson,
      fundAmount: i.fundAmount,
      guardianPasskey: i.guardianPasskey,
      provision,
      signerForEntity,
      outflows,
      custody: i.custody,
      provisionCircle,
      circleSignerForEntity,
      derivePocketAddress,
      anchors,
      // Formation (Step 9) — the pin and the filer as ONE object (M3), so this root cannot hand
      // the saga a provider to pin without also handing it the client and the repositories that
      // would file for it. `environment` is the DEPLOYMENT's, deliberately separate from
      // `pin.environment`: an entity pinned earlier still owes its filing a correctly-routed
      // call, whatever the config has since become.
      formation: doolaApi
        ? {
            doola: doolaApi,
            requests: formationRequests,
            parties: formationParties,
            companies,
            environment: cfg.doola!.environment,
            // The SSN keyring (§4.2): the create forwards it ONCE and deletes it in the
            // transaction that records the company id.
            pii: formationCfg.pii,
          }
        : undefined,
    });

  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: { perCall: cfg.maxTreasuryFund, perTenantTotal: cfg.maxTreasuryFundedPerTenant },
    outflows,
    // Formation, re-keyed to companies (2026-08-26 §3). Present only where a company could be
    // minted or attached: the pin is copied from the company ROW inside the claim, so this block
    // carries the stores rather than a deployment pin.
    formation: formationDeployment
      ? {
          companies,
          requests: formationRequests,
          maxAgentsPerCompany: formationCfg.maxAgentsPerCompany,
        }
      : undefined,
  });
  const resumed = runner.reconcileInFlight();
  if (resumed) console.log(`Resumed ${resumed} in-flight onboarding(s)`);

  // ── The formation loop (design §5/§6/§7) ─────────────────────────────────────────────────
  //
  // All three parts share ONE dependency object, deliberately: the webhook processor and the
  // sweeper's poll are the same fetch-and-advance, and giving them separate wiring would be the
  // first step toward them disagreeing about what "filed" means.
  //
  // Every piece is gated on `doolaApi`, so a credential-less deployment mounts no receiver,
  // starts no timer, and reconciles nothing — the stub shape stays exactly as it was.
  // ── The view dependencies (C8) ───────────────────────────────────────────────────────────
  //
  // Built ONCE and spread into `buildApiApp`, which hands the same object to the MCP server. The
  // two surfaces used to be wired separately and the MCP one was missing the document index, so
  // `get_entity` over MCP described an entity with no legal documents while `GET /entities/:id`
  // described the same entity with two. Nothing errored; the agent surface was quietly less true.
  //
  // Always wired, credentials or not: these are plain SQL over the same database, not part of the
  // doola capability, and an entity already filed must stay describable — and its PDFs
  // downloadable — on a box that has since lost its doola block.
  const entityViewDeps = {
    // Company-keyed since the re-key: one filing, one set of steps, however many agents share it.
    formationSteps: (companyId: string) => formationRequests.stepsOf(companyId),
    // The batched twin the list routes use: one read per page instead of two per entity (M5).
    formationStepsMany: (companyIds: string[]) => formationRequests.stepsOfMany(companyIds),
    company: (companyId: string) => companies.find(companyId),
    companyMany: (companyIds: string[]) => companies.findMany(companyIds),
    companies,
    // The §7 sharing label, on the authenticated surfaces only. The SAME store, narrowed to the
    // two counting reads by `EntityViewDeps` — `/transparency` and `/metadata` build their rows
    // from `formationSummary` and never receive this object.
    companyAgents: companies,
    documents: formationDocuments,
  };

  const doolaTasks = new TaskTracker("doola_webhook_task");
  const formationDeps = doolaApi && {
    repo,
    requests: formationRequests,
    parties: formationParties,
    companies,
    documents: formationDocuments,
    docStore,
    events: doolaEvents,
    doola: doolaApi,
    // The DEPLOYMENT's environment, which is what every entity's pin is compared against.
    environment: cfg.doola!.environment,
    // The SSN keyring (§4.2). The sweeper hands it to the filing step, which needs it to rebuild
    // a body it already sent, and to the TTL leg, which needs only to erase.
    pii: formationCfg.pii,
    // The eighth leg's wiring (§6.4) — the SAME payment config and executor the settle route
    // holds, so the sweeper and the route resolve one payment through one set of rules. Absent
    // where the deployment does not charge, and the leg is then a no-op.
    payment:
      formationPayment.required && formationExecutor
        ? {
            payment: formationPayment,
            executor: formationExecutor,
            transaction: <T>(fn: () => T) => repo.transaction(fn),
          }
        : undefined,
    intervalMs: cfg.formation?.sweepMs ?? 60_000,
    // The anchor sub-saga (design §7). The SAME `anchors` repo the saga writes the v1 row with
    // and the SAME `arc` adapter the saga mints through — a second adapter would be a second
    // manager identity, and a second repo would be a second opinion about what the chain holds.
    anchor: { anchors, arc, chainId: cfg.chainId },
    // The settling window the anchor gate folds late facts over (§3). The sweep interval IS the
    // window: facts that land inside one tick become one amendment cycle per attached agent.
    sweepIntervalMs: cfg.formation?.sweepMs ?? 60_000,
  };
  const formationSweeper = formationDeps ? new FormationSweeper(formationDeps) : undefined;

  const jobDeps = buildJobDeps(cfg, db, repo, docStore, circleApi);
  const resumedJobs = jobDeps.jobRunner.reconcileInFlight();
  if (resumedJobs) console.log(`Resumed ${resumedJobs} in-flight job(s)`);

  const x402Demo = buildX402DemoDeps(cfg);
  // World gate on the demo seller: authorize human-backed agents (AgentBook on World Chain)
  // before requiring payment. Settlement stays on Arc, untouched.
  if (x402Demo && cfg.worldChain) {
    const host = new URL(x402Demo.resourceUrl).hostname;
    x402Demo.agentkit = {
      domain: host,
      resourceUrl: x402Demo.resourceUrl,
      network: x402Demo.network,
      store: new SqliteWorldStore(db),
      allowancePerHuman: cfg.worldChain.allowancePerHuman,
      worldChainRpc: cfg.worldChain.rpcUrl,
      agentBookAddress: cfg.worldChain.agentBook,
      // One url per chain we advertise (design v3 D10): the verifier is handed the url for
      // whichever chain the inbound payload names — Arc for a client that signed against the paid
      // route, World Chain for one that signed against `eip155:480`. An EIP-191 proof needs
      // neither (the address is recovered locally); an ERC-1271 proof needs the url for the chain
      // its smart account lives on, since verifying it is a contract call there.
      rpcUrls: { [x402Demo.network]: cfg.rpcUrl, [AGENT_BOOK_CAIP2]: cfg.worldChain.rpcUrl },
      rateWindowMs: (cfg.worldRateWindowHours ?? 24) * 3_600_000,
    };
    x402Demo.proofAgentKey = cfg.x402ProofAgentKey;
  }
  // The configured policy is carried by `buildX402DemoDeps` itself and therefore reaches the
  // paywall whether or not the World config survived (final pass C3) — announced here, outside the
  // block above, for the same reason: a box running `legal-bodies-only` with no World credentials
  // must say so and refuse (503), not fall through to `open` in silence.
  if (x402Demo) {
    console.warn(`⚠ x402 demo seller ENABLED at /x402-demo/quote (payTo ${x402Demo.payTo})`);
    if (x402Demo.trustPolicy === "accountable-only")
      console.warn("⚠ x402 seller policy: ACCOUNTABLE-ONLY — anonymous agents are refused (403)");
    if (x402Demo.trustPolicy === "legal-bodies-only")
      console.warn(
        "⚠ x402 seller policy: LEGAL-BODIES-ONLY — only agents a registered legal body in good standing stands behind are served (403 otherwise)",
      );
  }

  // AgentBook (design 2026-08-25 v3), in two halves.
  //
  // READING is unconditional: "does a verified human answer for this agent?" needs nothing but an
  // RPC URL, both of which have defaults, and the seller/buyer trust dials already read exactly
  // this way. WRITING is the optional half — it needs a funded submitter key AND the World portal
  // block, which is precisely `canRegisterAgentBook`, the same predicate the env.ts invariants and
  // GET /config use, so the boot gate and the advertised availability cannot drift.
  //
  // ONE rpc/contract pair for both halves: a reader and a registrar pointed at two different
  // AgentBooks would confirm registrations the seller check can never see.
  const agentBookRpc = cfg.worldChain?.rpcUrl ?? WORLD_CHAIN_DEFAULTS.rpcUrl;
  const agentBookContract = cfg.worldChain?.agentBook ?? WORLD_CHAIN_DEFAULTS.agentBook;
  // Through the predicate, so the submitter block is only in hand when the World portal block is
  // there too (the Orb gate reads `WorldStore`) — and so the presence of THIS value, not a second
  // hand-written condition, is what the write half below is built from.
  const submitter = canRegisterAgentBook(cfg) ? cfg.agentBook : undefined;
  const agentBook = {
    repo: new SqliteAgentBookRepository(db),
    reader: createAgentBookReader({ rpcUrl: agentBookRpc, contractAddress: agentBookContract }),
    store: new SqliteWorldStore(db),
    network: cfg.arcNetwork ?? ("testnet" as const),
    caps: { perEntityLifetime: 3, perTenantPerHour: 5 },
    // Status reads: their own allowance, so a dashboard refresh storm cannot starve a vouch and a
    // vouch storm cannot blind the chip. Reads are cached, so this covers misses only.
    readBudget: new TokenBucket(60, 2),
    registrar: submitter
      ? createAgentBookRegistrar({
          submitterPrivateKey: submitter.submitterPrivateKey,
          readRpcUrl: agentBookRpc,
          writeRpcUrl: submitter.rpcUrl,
          contractAddress: agentBookContract,
        })
      : undefined,
    budget: submitter ? new TokenBucket(30, 0.5) : undefined,
  };
  if (submitter)
    console.warn("⚠ AgentBook registration ENABLED at /entities/:id/agentbook/session");

  const ens = cfg.ens
    ? {
        signer: privateKeyToAccount(cfg.ens.signerKey),
        parentName: cfg.ens.parentName,
        metadataBaseUrl: cfg.metadataBaseUrl,
        identityRegistry: cfg.identityRegistry,
        chainId: cfg.chainId,
        resolverAddress: cfg.ens.resolverAddress,
        labelAliases: cfg.ens.labelAliases,
      }
    : undefined;
  if (ens) console.warn(`⚠ ENS gateway ENABLED at /ensgateway (parent ${ens.parentName})`);

  /**
   * Where the lookup points a seller for the human-readable version of the same facts.
   *
   * The transparency PAGE is on the web origin; a deployment with no explicit one (the dev
   * default, `*`) falls back to this API's own `/transparency`, which every deployment serves.
   * Wrapped because a misconfigured WEB_ORIGIN — anything `new URL` will not take — must cost a
   * less useful link and NEVER the API's ability to boot.
   */
  const transparencyLink = (() => {
    for (const base of [cfg.webOrigin, cfg.metadataBaseUrl]) {
      try {
        return new URL("/transparency", base).toString();
      } catch {
        // next candidate
      }
    }
    return `${cfg.metadataBaseUrl}/transparency`;
  })();

  // The legal-body half of the demo seller (design 2026-09-10 D4/D5). Wired HERE rather than up
  // in the x402 block because the refusal quotes `transparencyLink`, which is derived just above.
  //
  // The SAME resolver instance the buyer dial and the public lookup hold (D1), and the SAME base
  // url the lookup's own links are built from — a refusal that pointed a stranger's agent at a
  // different host, or at a second resolver, is how one suspension ends up meaning two things.
  if (x402Demo?.agentkit)
    x402Demo.legalBody = {
      resolver: legalBody,
      // The API's OWN origin when the deployment names one (PUBLIC_API_URL). On prod
      // METADATA_BASE_URL is the www/backend proxy, and that proxy's response allowlist drops
      // the CORS header and Cache-Control — so a browser-side seller following this link from a
      // refusal would get a CORS error instead of an answer.
      lookupBaseUrl: cfg.publicApiUrl ?? cfg.metadataBaseUrl,
      onboardUrl: "https://www.novicorpus.com/",
      transparencyUrl: transparencyLink,
    };

  const app = buildApiApp({
    webOrigin: cfg.webOrigin,
    nonceStore,
    siweDomain: cfg.siweDomain,
    chainId: cfg.chainId,
    jwtSecret: cfg.authJwtSecret,
    jwtTtlSec: cfg.authJwtTtlSec,
    platformManagerAddress,
    // Explicit apex target (design §5): unset keeps today's address — the platform signing key —
    // so controller mode never silently repoints the apex at a contract that cannot be paid.
    // Checksum-normalized ONCE here rather than on every gateway request (loadConfig already
    // validated the shape; this pins the canonical casing at the seam).
    ensApexAddress: getAddress(cfg.ensApexResolvesTo ?? executor.address),
    walletProviderDefault: cfg.walletProviderDefault,
    circleCustodyAvailable: Boolean(provisionCircle),
    // One predicate shared with the env.ts boot invariant (canProvisionTurnkey) — the advertised
    // availability and what provisioning actually needs can never drift apart. A deployment that
    // ships no TURNKEY_* is turnkey-less by construction — the mainnet circle-only shape.
    turnkeyCustodyAvailable: turnkeyServiceable,
    // Formation (design §2). ONE object: `canFormEntities` — the same predicate the env.ts boot
    // invariants use, so the boot gate and the advertised availability cannot drift apart — and
    // the environment it is available IN, which the honesty invariant makes inseparable from it.
    // Availability is NOT the pin: a box with credentials but FORMATION_REQUIRED off still
    // advertises the capability while pinning nothing.
    formation:
      canFormEntities(cfg) && companyDeps
        ? {
            environment: cfg.doola!.environment,
            required: formationCfg.required,
            sandboxSyntheticPii: formationCfg.sandboxSyntheticPii,
            maxPerTenant: formationCfg.maxPerTenant,
            dailyCeiling: formationCfg.dailyCeiling,
            maxAgentsPerCompany: formationCfg.maxAgentsPerCompany,
            parties: formationParties,
            requests: formationRequests,
            companies,
            pin: { provider: "doola", environment: cfg.doola!.environment },
            // The ONE method the compliance route calls, narrowed here rather than handed the
            // whole client (§7). Present only with a client to call it on.
            compliance: doolaApi,
            // The same object the shim uses; the doors add only their own transaction.
            companyDeps,
            // …and the payment config the quote/settle/cancel routes read. The SAME object
            // `companyDeps` carries, so the door that quotes and the door that settles can never
            // disagree about the fee, the payee or the domain.
            payment: formationPayment,
            // …and the fee ITSELF, whether or not this box charges: the beta sentence quotes it.
            feeUsdc: formationCfg.payment.feeUsdc,
            // The submitter. Present only where the box CHARGES, so a deployment that has
            // stopped can still read its payments while having no settle path wired at all.
            paymentExecutor: formationPayment.required ? formationExecutor : undefined,
          }
        : undefined,
    // The view dependencies, as ONE object shared with the MCP surface below (C8).
    ...entityViewDeps,
    // The inbound receiver (design §6). Present only with credentials: a box that cannot verify a
    // signature has no business owning the URL.
    doola:
      doolaApi && formationDeps
        ? {
            environment: cfg.doola!.environment,
            webhookSecret: cfg.doola!.webhookSecret,
            webhookSecretPrevious: cfg.doola!.webhookSecretPrevious,
            events: doolaEvents,
            tasks: doolaTasks,
            // The receiver hands over ids; this is where they become a re-fetch (audit H2).
            process: (wake) => processDoolaEvent(formationDeps, wake),
          }
        : undefined,
    repo,
    docStore,
    runner,
    passkeyRpId: cfg.passkeyRpId,
    apiKeys,
    passkeys,
    challenges,
    arc,
    jobs: jobDeps.jobs,
    jobRunner: jobDeps.jobRunner,
    jobClientAddress: jobDeps.jobClientAddress,
    jobEvaluatorAddress: jobDeps.jobEvaluatorAddress,
    maxJobBudget: cfg.maxJobBudget,
    maxInflightJobsPerTenant: cfg.maxInflightJobsPerTenant,
    agentRuns,
    mcpPublicUrl: cfg.mcpPublicUrl,
    linkCodes: new SqliteLinkCodeStore(db),
    payments,
    pocketFunding,
    x402Demo,
    ens,
    worldId,
    agentBook,
    /**
     * The public legal-body lookup, `GET /legal-bodies/:address` (design 2026-09-10 D3).
     *
     * The SAME resolver instance the buyer dial got above (D1) — not a second one built from the
     * same parts, which is how two surfaces end up disagreeing about one suspension.
     */
    hedera,
    legalBody: {
      resolver: legalBody,
      // The resolver's own two reads, UNWRAPPED — the Hedera `check_policy` tool holds an entity
      // record already, so it needs the reads and not the address lookup. Same `arc` adapter the
      // resolver above closes over, so the two can never answer differently about one suspension.
      chainReads: {
        legalStatus: (proxy) => arc.legalStatus(proxy),
        treasuryPaused: (treasury) => arc.treasuryPaused(treasury),
      },
      /**
       * 30 burst, 1 per second sustained, and spent only on a memo MISS.
       *
       * Smaller than the AgentBook status budget on purpose: this route is UNAUTHENTICATED, so
       * nothing else bounds how often it is asked, and every miss is two Arc reads on the same
       * RPC the trust dials and the sweeper share. A judge refreshing a page rides the memo.
       */
      readBudget: new TokenBucket(30, 1),
      links: {
        transparency: transparencyLink,
        // The base the on-chain `metadataURI` is built from (workflow/onboarding.ts), so the link
        // a seller follows is the very document the chain points at.
        metadataBase: cfg.metadataBaseUrl,
      },
      // The SHARED projection, through the same two lookups `/transparency` reads (M5's
      // company-keyed pair), so a public surface cannot describe a filing differently from the
      // public surface next door.
      formationSummary: (companyId: string) =>
        formationSummary(
          entityViewDeps.company(companyId),
          entityViewDeps.formationSteps(companyId),
        ),
      // The AgentBook status route's derivation, verbatim — one deployment, one named chain.
      network: agentBook.network,
    },
    standingExposure,
  });

  const port = Number(process.env.PORT ?? 8789);
  const server = serve({ fetch: app.fetch, port });
  console.log(`Wizard API listening on :${port}`);

  // ── C4. The formation reconcile happens AFTER the socket is listening, never before it.
  //
  //    It used to be `await formationReconcile(sweeper)` up beside the other two reconcilers, and
  //    that put doola on the boot path: the reconcile fetch-and-advances every in-flight entity,
  //    each one a network round trip to a third party, before `serve()` was ever called. A doola
  //    outage or a slow morning therefore delayed the port opening — so /healthz did not answer,
  //    the load balancer marked the box down, and the deploy failed for a reason that has nothing
  //    to do with whether this process can serve requests. A formation provider must never be
  //    able to keep the API from starting.
  //
  //    `start()` runs its first loop iteration immediately, and that iteration IS the reconcile —
  //    which is why there is no separate tick here any more: the duplicate would have doubled
  //    every boot's doola traffic for nothing.
  if (formationSweeper) {
    formationSweeper.start();
    console.log(`Formation sweeper started (every ${formationDeps!.intervalMs}ms)`);
  }

  // AgentBook reconcile at boot (D12), and AFTER the socket is listening for the same reason C4
  // moved the formation reconcile down here: every in-flight row costs a World Chain round trip
  // to a third party, and a slow or unreachable RPC must never be able to keep /healthz from
  // answering. Usually a no-op — with nothing in flight it makes no call at all.
  if (agentBook.registrar) {
    const r = await reconcileAgentBook({
      repo: agentBook.repo,
      registrar: agentBook.registrar,
      store: agentBook.store,
      log: opsLog,
    });
    console.log(`AgentBook reconcile at boot: ${r.checked} checked, ${r.changed} changed`);
  }

  // The API process's FIRST signal handlers (design §7). Until part B every unit of work was a
  // request, so a restart only dropped HTTP a client would retry; now the process also holds
  // acked webhook work and an unattended timer. Guarded so importing this module under a test
  // runner never installs a handler that would exit the runner.
  if (shouldInstallSignalHandlers())
    installShutdownHandlers({ sweeper: formationSweeper, tasks: doolaTasks, server });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
