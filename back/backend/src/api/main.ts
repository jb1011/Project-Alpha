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
} from "../adapters/arc/clients";
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
import { arcBatchingConfig } from "../adapters/x402/pocket";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { SqliteNonceStore } from "../auth/nonceStore";
import {
  WORLD_CHAIN_DEFAULTS,
  canFormEntities,
  canProvisionTurnkey,
  loadConfig,
} from "../config/env";
import { resolveFormationDeployment } from "../formation";
import { buildJobDeps } from "../jobs/composition";
import { createAgentBookReader } from "../payments/agentBookReader";
import { buildEntityPaymentService } from "../payments/entityPayment";
import { PaymentLedger } from "../payments/ledger";
import { buildOutflowMeter } from "../payments/outflowMeter";
import { buildPocketFunding } from "../payments/pocketFunding";
import { buildSellerTrust } from "../payments/sellerTrust";
import { buildReadExposure } from "../payments/standingExposure";
import { SqliteAgentRunStore } from "../persistence/agentRunStore";
import { SqliteApiKeyStore } from "../persistence/apiKeyStore";
import { SqliteBridgeLegRepository } from "../persistence/bridgeLegRepository";
import { SqliteChallengeStore } from "../persistence/challengeStore";
import { migrate, openDatabase } from "../persistence/db";
import { SqliteDocumentIndexRepository } from "../persistence/documentIndexRepository";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteDoolaEventRepository } from "../persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../persistence/formationRepository";
import { SqliteLinkCodeStore } from "../persistence/linkCodeStore";
import { SqliteOaAnchorRepository } from "../persistence/oaAnchorRepository";
import { SqlitePasskeyStore } from "../persistence/passkeyStore";
import { SqlitePaymentIdempotencyStore } from "../persistence/paymentIdempotencyStore";
import {
  assertCircleCoverage,
  assertTurnkeyCoverage,
  backfillPocketAddresses,
} from "../persistence/tier0";
import { SqliteWorldStore } from "../persistence/worldStore";
import { usdToUnits } from "../policy/units";
import type { Address } from "../types";
import { TaskTracker } from "../util/taskTracker";
import { processDoolaEvent } from "../workflow/formationProcessor";
import { FormationSweeper } from "../workflow/formationSweeper";
import { runOnboarding } from "../workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../workflow/runner";
import { buildApiApp } from "./app";
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
  const repo = new SqliteEntityRepository(db);
  // Same db handle as `repo`, deliberately: the v1 anchor row is written INSIDE the entity row's
  // transaction at create-confirm, so the entity store and the anchor history can never disagree
  // about what the chain holds.
  const anchors = new SqliteOaAnchorRepository(db);
  // Same db handle again: the four formation step rows are claimed inside one transaction, the
  // spend-control counts JOIN `entities`, and the party bind commits with the entity claim.
  const formationRequests = new SqliteFormationRepository(db);
  const formationParties = new SqliteFormationPartyRepository(db);
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
          // Legal-bodies tier: local registry lookup + the same Arc reads the dashboard trusts.
          legalBodies: {
            findByTreasury: (addr) => {
              const rec = repo.findByTreasury(addr);
              return rec ? { proxy: rec.proxy, treasury: rec.treasury } : undefined;
            },
            legalStatus: (proxy) => arc.legalStatus(proxy),
            treasuryPaused: (treasury) => arc.treasuryPaused(treasury),
          },
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
      "⚠ FORMATION_REQUIRED=false — formation is AVAILABLE, not mandatory: an onboard is only pinned and filed when it carries a partyId, and the wizard does not send one yet (docs/runbooks/doola-deploy.md)",
    );

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
            pin: formationDeployment,
            doola: doolaApi,
            requests: formationRequests,
            parties: formationParties,
            environment: cfg.doola!.environment,
          }
        : undefined,
    });

  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: { perCall: cfg.maxTreasuryFund, perTenantTotal: cfg.maxTreasuryFundedPerTenant },
    outflows,
    formation: formationDeployment,
    parties: formationParties,
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
    formationSteps: (entityKey: string) => formationRequests.stepsOf(entityKey),
    documents: formationDocuments,
  };

  const doolaTasks = new TaskTracker("doola_webhook_task");
  const formationDeps = doolaApi && {
    repo,
    requests: formationRequests,
    parties: formationParties,
    documents: formationDocuments,
    docStore,
    events: doolaEvents,
    doola: doolaApi,
    // The DEPLOYMENT's environment, which is what every entity's pin is compared against.
    environment: cfg.doola!.environment,
    intervalMs: cfg.formation?.sweepMs ?? 60_000,
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
      rpcUrls: { [x402Demo.network]: cfg.rpcUrl },
      rateWindowMs: (cfg.worldRateWindowHours ?? 24) * 3_600_000,
    };
    x402Demo.trustPolicy = cfg.x402TrustPolicy ?? "open";
    x402Demo.proofAgentKey = cfg.x402ProofAgentKey;
    if (x402Demo.trustPolicy === "accountable-only")
      console.warn("⚠ x402 seller policy: ACCOUNTABLE-ONLY — anonymous agents are refused (403)");
  }
  if (x402Demo)
    console.warn(`⚠ x402 demo seller ENABLED at /x402-demo/quote (payTo ${x402Demo.payTo})`);

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

  const worldStore = new SqliteWorldStore(db);
  const worldId = cfg.world
    ? {
        cfg: {
          appId: cfg.world.appId,
          rpId: cfg.world.rpId,
          rpSigningKey: cfg.world.rpSigningKey,
          action: cfg.world.action,
          environment: cfg.world.environment,
          attestAction: cfg.world.attestAction,
        },
        store: worldStore,
        maxEntitiesPerHuman: cfg.world.maxEntitiesPerHuman,
        attestMinAge: cfg.world.attestMinAge,
        requireGuardian: cfg.world.requireGuardian,
      }
    : undefined;
  if (worldId)
    console.warn(
      `⚠ World ID guardian gate ENABLED (action ${worldId.cfg.action}, env ${worldId.cfg.environment}, enforce=${worldId.requireGuardian})`,
    );
  if (worldId?.cfg.attestAction)
    console.warn(
      `⚠ Identity attestation step-up ENABLED (action ${worldId.cfg.attestAction}, min age ${worldId.attestMinAge})`,
    );

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
    formation: canFormEntities(cfg)
      ? {
          environment: cfg.doola!.environment,
          required: Boolean(cfg.formation?.required),
          sandboxSyntheticPii: Boolean(cfg.formation?.sandboxSyntheticPii),
          maxPerTenant: cfg.formation?.maxPerTenant ?? 3,
          dailyCeiling: cfg.formation?.dailyCeiling ?? 10,
          parties: formationParties,
          requests: formationRequests,
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
