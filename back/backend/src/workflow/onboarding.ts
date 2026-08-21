import { randomUUID } from "node:crypto";
import { type Address, hexToString, toHex } from "viem";
import type { ArcAdapter } from "../adapters/arc/arcAdapter";
import { buildWalletSetTypedData } from "../adapters/arc/walletSet";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import type { OperatorSigner } from "../adapters/turnkey/signer";
import { computeOaHash, renderMetadata, renderOperatingAgreement } from "../oa/generator";
import {
  OA_MANIFEST_VERSION_V1,
  buildManifestV1,
  manifestDocName,
  manifestHash,
  serializeManifest,
  termsDocName,
} from "../oa/manifest";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { AgentSpec } from "../policy/agentSpec";
import { assertOperatorDistinct, translate } from "../policy/translator";
import { usdToUnits } from "../policy/units";
import type { EntityRecord, FormationPin, Hex } from "../types";

/** Result of provisioning a per-agent Turnkey vault (the saga only needs these three fields). */
export interface ProvisionedVault {
  subOrgId: string;
  walletId: string;
  operator: string;
}

/** Result of provisioning the per-agent Circle wallets (Tier-0: SCA operator + EOA pocket). */
export interface ProvisionedCircleWallets {
  operator: string; // the SCA address — becomes the entity operator
  operatorWalletId: string;
  pocketWalletId: string;
  pocketAddress: string;
  walletSetId: string;
}

export interface OnboardingDeps {
  spec: AgentSpec;
  idempotencyKey: string;
  repo: EntityRepository;
  docStore: DocumentStore;
  arc: ArcAdapter;
  operatorSigner: OperatorSigner;
  usdc: Address; // default USDC for the translator
  /** Public base URL for the on-chain metadataURI: ${metadataBaseUrl}/metadata/<publicId>. OPTIONAL
   *  (default localhost) so the existing saga tests compile untouched; the REAL callers (main.ts
   *  runSaga + cli create-entity) always pass the prod-guarded cfg.metadataBaseUrl. */
  metadataBaseUrl?: string;
  /** ENS parent name (e.g. "novicorpus.eth"). When set, the saga writes the ENSIP-25 reverse
   *  binding (setMetadata(agentId,"ens","<publicId>.<parent>")) so the registry points back at the
   *  agent's ENS name. Optional + non-fatal — absent leaves onboarding unchanged. */
  ensParentName?: string;
  /** Owning tenant (controller wallet address); persisted on every record the saga writes. */
  ownerTenantId?: string;
  /** Validated AgentSpec JSON; persisted so the reconciler/fund can re-run the saga. */
  specJson?: string;
  fundAmount?: bigint; // optional: top up the treasury after binding (status -> funded)
  /** S5: records the platform->treasury outflow on success (check happens in runner.fund). */
  outflows?: { record(path: "fund_treasury", amountAtomic: bigint, ref: string | null): void };
  // ── Per-agent Turnkey vault (Step 0). When BOTH `provision` and `guardianPasskey` are present, the
  //    saga provisions a per-agent sub-org BEFORE minting and uses its operator/signer instead of the
  //    shared `operatorSigner`. Absent both -> legacy shared-key path (unchanged).
  /** Guardian passkey for the new sub-org's root user. Presence (+ `provision`) triggers Step 0. */
  guardianPasskey?: GuardianPasskey;
  /** Provision a per-agent vault. Real = provisionAgentVault(buildTurnkeyProvisionDeps(cfg), …). */
  provision?: (params: {
    subOrgName: string;
    guardianPasskey: GuardianPasskey;
    guardianEmail?: string;
  }) => Promise<ProvisionedVault>;
  /** Build the per-entity operator signer. Real = (e) => TurnkeySigner.forEntity(cfg, e). */
  signerForEntity?: (e: { subOrgId: string; operator: string }) => Promise<OperatorSigner>;
  // ── Tier-0 custody choice (docs/design/2026-08-03-tier0-circle-wallet-migration.md).
  /** Custody provider for a NEW record. A resumed record's persisted walletProvider always wins —
   *  custody is immutable after the claim. Absent -> "turnkey" (every pre-Tier-0 caller). */
  custody?: "turnkey" | "circle";
  /** Provision the per-agent Circle wallets (SCA operator + EOA pocket). Real = wraps
   *  provisionCircleWallets(circleApi, { walletSetId, blockchain, entityKey }). NOTE: Circle
   *  createWallets is not idempotent — a crash between provisioning and persisting re-provisions
   *  on resume, orphaning one wallet pair (tagged by metadata.refId, unused, ~free under MAW
   *  billing). Accepted; the alternative (failing the resume) strands the onboarding. */
  provisionCircle?: (params: {
    entityKey: string;
    name: string;
  }) => Promise<ProvisionedCircleWallets>;
  /** Circle-path bind signer: the operator SCA signs AgentWalletSet via Circle (ERC-1271 — the
   *  live-registry acceptance is the P2 known-unknown). Real = circleOperatorSigner(api, …). */
  circleSignerForEntity?: (e: { operatorWalletId: string; operator: string }) => OperatorSigner;
  /** Turnkey-path creation-time pocket address (audit item 7: derive ONCE at creation, store, so
   *  read paths never touch the master seed again — the P1a backfill only covered existing rows).
   *  Real = privateKeyToAccount(derivePocketKey(seed, entityKey)).address. Circle-path pockets
   *  come from provisioning instead. */
  derivePocketAddress?: (entityKey: string) => string;
  // ── doola formation (design 2026-08-19 §2/§5). PR 1 only PINS the provider on the record; the
  //    filing itself is PR 2.
  /** Formation provider + environment for a NEW record, from config. A resumed record's
   *  persisted pair always wins — the custody-resolution twin: the environment an in-flight
   *  entity was pinned to can never be re-pointed by a config flip (audit M5). Absent (no doola
   *  credentials) = stub mode: `formation_provider` stays null, forever, and NOTHING else in the
   *  saga changes. */
  formation?: FormationPin | null;
}

/**
 * Which OA anchoring scheme this record derives its `oa_hash` under (design §4, completeness 1).
 *
 * The manifest scheme applies to NEW entities. The one record that must NOT be upgraded is one
 * caught mid-onboarding by the deploy: it has already BROADCAST `createEntity` with the legacy
 * doc hash as an argument, so re-deriving the anchor on resume would silently diverge the DB
 * from the chain — a permanently unverifiable entity, and exactly the failure the split
 * broadcast/confirm window exists to prevent.
 *
 * The commitment is therefore sticky in BOTH directions: a record that already wrote a manifest
 * hash keeps the manifest scheme even after its own create tx is broadcast (otherwise the
 * translating-resume would flip it back to legacy and diverge in the other direction), and a
 * record that broadcast without one keeps the legacy derivation forever.
 */
export function usesManifestScheme(
  rec:
    | Pick<EntityRecord, "createTxHash" | "oaManifestVersion" | "oaManifestPendingHash">
    | undefined,
): boolean {
  if (rec?.oaManifestVersion != null || rec?.oaManifestPendingHash != null) return true;
  return rec?.createTxHash == null;
}

/**
 * Onboarding saga. Idempotent + resumable: each step is skipped if the persisted status is already
 * past it. `createEntity` (the only step that mints a NEW agentId) is skipped ONCE its result is
 * persisted — a key at status 'created' or beyond reuses the stored agentId. Each step's two DB
 * writes (entity row + audit event) commit atomically via repo.transaction().
 *
 * create→persist double-mint window CLOSED: step 4 broadcasts the createEntity tx, persists its hash
 * at status 'translating' BEFORE awaiting the receipt, then confirms. A crash in that gap resumes by
 * adopting the persisted tx (confirm re-reads the same agentId) instead of minting a second entity.
 *
 * Concurrent double-mint is guarded one level up: OnboardingRunner.start claims the idempotency key
 * atomically (repo.claimKey, INSERT ON CONFLICT DO NOTHING) before any side effect, so two runners
 * racing the same key cannot both reach step 4.
 *
 * v1 limitations still KNOWN (harden before production):
 *  - key-wins semantics: re-running a key reuses the stored record and ignores any changed spec; do
 *    not reuse an idempotencyKey with a different spec.
 */
export async function runOnboarding(d: OnboardingDeps): Promise<EntityRecord> {
  const key = d.idempotencyKey;
  let rec = d.repo.findByIdempotencyKey(key);

  // Tier-0 custody resolution: for ANY existing record the persisted provider wins — including
  // legacy rows whose walletProvider is null, which MEAN turnkey (review M2: `rec?.wp ?? input`
  // would let a caller's custody input CONVERT an existing pre-Tier-0 record). Only a genuinely
  // fresh record takes the caller's choice; default turnkey (every pre-Tier-0 path).
  const custody: "turnkey" | "circle" = rec
    ? (rec.walletProvider ?? "turnkey")
    : (d.custody ?? "turnkey");

  // Formation pinning, the custody twin (design §2, audit M5): for ANY existing record the
  // PERSISTED provider/environment win — including legacy rows whose pair is null, which mean
  // "stub forever". Only a genuinely fresh record takes this deployment's configuration, so a
  // mainnet flip can never re-route an in-flight sandbox company at the production host.
  const formationProvider = rec ? (rec.formationProvider ?? null) : (d.formation?.provider ?? null);
  const formationEnvironment = rec
    ? (rec.formationEnvironment ?? null)
    : (d.formation?.environment ?? null);

  // ── Step 0a (circle custody): provision the per-agent Circle wallets (SCA operator + EOA
  //    pocket) BEFORE minting — the SCA address IS the on-chain operator. No Turnkey sub-org on
  //    this path; the guardian passkey is still recorded (rootPasskeyId, runner claim) as the
  //    guardian's identity anchor. On resume, a record already carrying circleOperatorWalletId is
  //    NOT re-provisioned.
  // Status gate (review M2): provisioning may only run on a fresh or freshly-claimed record —
  // never against one that already minted/bound (that would overwrite the on-chain operator).
  if (custody === "circle" && !rec?.circleOperatorWalletId && (!rec || rec.status === "pending")) {
    if (!d.provisionCircle)
      throw new Error(
        `entity ${key} requested circle custody but this deployment has no Circle provisioning configured (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET/CIRCLE_WALLET_SET_ID)`,
      );
    const wallets = await d.provisionCircle({ entityKey: key, name: d.spec.name });
    const provisioned: EntityRecord = {
      // Minimal pre-translate row (mirrors the Turnkey Step 0 below); translate re-derives the
      // policy fields and keeps this operator.
      idempotencyKey: key,
      name: d.spec.name,
      status: "provisioned",
      manager: d.spec.roles.manager as Address,
      guardian: d.spec.roles.guardian as Address,
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
      ownerTenantId: d.ownerTenantId,
      error: null,
      specJson: d.specJson ?? null,
      perTxCap: null,
      formationProvider,
      formationEnvironment,
      ...rec, // a claimed 'pending' row keeps its identity fields (incl. rootPasskeyId)
      operator: wallets.operator as Address,
      walletProvider: "circle",
      circleWalletSetId: wallets.walletSetId,
      circleOperatorWalletId: wallets.operatorWalletId,
      circlePocketWalletId: wallets.pocketWalletId,
      pocketAddress: wallets.pocketAddress,
    };
    provisioned.status = "provisioned";
    rec = provisioned;
    d.repo.transaction(() => {
      d.repo.upsert(provisioned);
      d.repo.recordEvent(
        key,
        "provisionCircleWallets",
        "provisioned",
        null,
        JSON.stringify({
          operator: wallets.operator,
          operatorWalletId: wallets.operatorWalletId,
          pocketWalletId: wallets.pocketWalletId,
          pocketAddress: wallets.pocketAddress,
        }),
      );
    });
  }

  // ── Step 0 (optional, turnkey custody): provision the per-agent Turnkey vault BEFORE minting.
  //    Triggered only when a `provision` seam + a `guardianPasskey` are supplied. Idempotent: on
  //    resume, a record that already carries `turnkeySubOrgId` is NOT re-provisioned (no second
  //    sub-org) — its stored sub-org id + operator are reused for createEntity/bind below.
  //    'provisioned' precedes 'created'.
  if (custody === "turnkey" && d.provision && d.guardianPasskey && !rec?.turnkeySubOrgId) {
    const vault = await d.provision({
      subOrgName: d.spec.name,
      guardianPasskey: d.guardianPasskey,
    });
    // Creation-time pocket address (audit item 7): derive once, store — new turnkey agents must
    // not re-open the master-seed dependency the P1a backfill closed for existing rows.
    const pocketAddress = d.derivePocketAddress?.(key) ?? null;
    const provisioned: EntityRecord = rec
      ? {
          ...rec,
          status: "provisioned",
          operator: vault.operator as Address,
          turnkeySubOrgId: vault.subOrgId,
          turnkeyWalletId: vault.walletId,
          walletProvider: "turnkey",
          pocketAddress: rec.pocketAddress ?? pocketAddress,
        }
      : {
          // Minimal pre-translate row: only the provision result + identity fields are known yet.
          // The translate step (below) re-derives all the policy fields and keeps this operator.
          idempotencyKey: key,
          name: d.spec.name,
          status: "provisioned",
          manager: d.spec.roles.manager as Address,
          guardian: d.spec.roles.guardian as Address,
          operator: vault.operator as Address,
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
          turnkeySubOrgId: vault.subOrgId,
          turnkeyWalletId: vault.walletId,
          walletProvider: "turnkey",
          pocketAddress,
          ownerTenantId: d.ownerTenantId,
          error: null,
          specJson: d.specJson ?? null,
          perTxCap: null,
          formationProvider,
          formationEnvironment,
        };
    rec = provisioned;
    d.repo.transaction(() => {
      d.repo.upsert(provisioned);
      d.repo.recordEvent(
        key,
        "provisionVault",
        "provisioned",
        null,
        JSON.stringify({
          subOrgId: vault.subOrgId,
          walletId: vault.walletId,
          operator: vault.operator,
        }),
      );
    });
  }

  // ── Step 1+2: translate (pure) + generate OA/metadata. Re-derivable; (re)write if not yet created.
  if (
    !rec ||
    rec.status === "pending" ||
    rec.status === "provisioned" ||
    rec.status === "translating"
  ) {
    const r = translate(d.spec, { usdc: d.usdc });
    // Provisioned path (either custody): the operator persisted in Step 0 — the per-agent Turnkey
    // key or the Circle SCA. Legacy path: the shared operatorSigner's address.
    const provisioned0 = Boolean(rec?.turnkeySubOrgId || rec?.circleOperatorWalletId);
    const operator = provisioned0 ? rec!.operator! : d.operatorSigner.address;
    assertOperatorDistinct(r, operator); // operator now known -> full distinctness check
    const resolved = { ...r, operator };
    const publicId = rec?.publicId ?? randomUUID(); // minted once; preserved across a translating-resume
    const metadataBaseUrl = d.metadataBaseUrl ?? "http://localhost:8789"; // real callers pass the guarded cfg value

    // ── The anchor (design §4). Under the MANIFEST scheme the on-chain `oa_hash` commits to the
    //    bundle manifest — terms doc + chain identity + (from v2) the legal facts — instead of to
    //    the terms doc alone. The terms doc is still written, versioned, and its keccak is what
    //    `terms.hash` inside the manifest points at, so nothing is lost: the anchor simply covers
    //    strictly more. A record already carrying a broadcast create tx keeps the LEGACY
    //    derivation (see usesManifestScheme) — its hash is already an argument of an in-flight tx.
    const manifestScheme = usesManifestScheme(rec);
    const doc = renderOperatingAgreement(d.spec, resolved, {
      scheme: manifestScheme ? "manifest" : "legacy",
    });
    let oaHash: Hex;
    let docPut: { path: string };
    let manifestPendingHash: Hex | null = rec?.oaManifestPendingHash ?? null;
    if (manifestScheme) {
      const manifest = buildManifestV1(d.spec, resolved, publicId, {
        chainId: d.arc.chainId,
        entityKey: key,
      });
      oaHash = manifestHash(manifest);
      docPut = d.docStore.put(termsDocName(key, OA_MANIFEST_VERSION_V1), doc);
      // Bytes, not a string: the manifest is HASHED, so it goes through the atomic writer — a
      // torn file whose hash is anchored is permanently unverifiable (audit M7).
      d.docStore.putBytes(
        manifestDocName(key, OA_MANIFEST_VERSION_V1),
        Buffer.from(serializeManifest(manifest), "utf8"),
      );
      // v1 is PENDING until createEntity confirms; the create-confirm below promotes it to
      // anchored. This is also the sticky marker that keeps a resumed record on this scheme.
      manifestPendingHash = oaHash;
    } else {
      oaHash = computeOaHash(doc);
      docPut = d.docStore.put(`oa-${key}.md`, doc);
    }
    const meta = renderMetadata(d.spec, resolved, oaHash);
    d.docStore.put(`meta-${key}.json`, JSON.stringify(meta, null, 2)); // written for the public route to serve

    rec = {
      idempotencyKey: key,
      name: d.spec.name,
      status: "translating",
      manager: r.manager,
      guardian: r.guardian,
      operator,
      amendmentDelay: r.amendmentDelay.toString(),
      ein: r.legal.ein,
      formationDate: r.legal.formationDate,
      oaHash,
      metadataURI: `${metadataBaseUrl}/metadata/${publicId}`,
      publicId,
      docPath: docPut.path,
      treasuryConfig: r.treasury,
      agentId: null,
      proxy: null,
      treasury: null,
      // Preserve a broadcast-but-unconfirmed create tx across a translating-resume: translate is
      // re-derivable and re-runs while status is still 'translating', but it must NOT wipe a hash we
      // already persisted, or step 4 would re-mint instead of adopting it.
      createTxHash: rec?.createTxHash ?? null,
      bindTxHash: null,
      fundTxHash: null,
      // Carry the Step-0 custody fields forward (undefined on the legacy shared-key path).
      turnkeySubOrgId: rec?.turnkeySubOrgId,
      turnkeyWalletId: rec?.turnkeyWalletId,
      walletProvider: rec?.walletProvider ?? (custody === "circle" ? "circle" : null),
      circleWalletSetId: rec?.circleWalletSetId,
      circleOperatorWalletId: rec?.circleOperatorWalletId,
      circlePocketWalletId: rec?.circlePocketWalletId,
      // Legacy shared-key path still gets a creation-time pocket address when the seed is around.
      pocketAddress: rec?.pocketAddress ?? d.derivePocketAddress?.(key) ?? null,
      rootPasskeyId: rec?.rootPasskeyId,
      // Review M3: the rebuild must not silently NULL guardian-set / forensic fields — a resume
      // after the guardian tightened the trust dial was resetting it to the looser default.
      trustPolicy: rec?.trustPolicy ?? null,
      previousOperator: rec?.previousOperator ?? null,
      operatorRotatedAt: rec?.operatorRotatedAt ?? null,
      ownerTenantId: d.ownerTenantId ?? rec?.ownerTenantId,
      error: null,
      specJson: d.specJson ?? rec?.specJson ?? null,
      perTxCap:
        d.spec.treasury.perTxCapUsdc != null ? usdToUnits(d.spec.treasury.perTxCapUsdc) : null,
      // Formation: pinned here (custody twin) and never re-derived from config afterwards.
      // Null on a credential-less deployment = stub, which is what every legacy row stays.
      formationProvider,
      formationEnvironment,
      // The rebuild must not NULL facts a later sub-saga earned (same rule as trustPolicy above).
      einReal: rec?.einReal ?? null,
      formationFiledAt: rec?.formationFiledAt ?? null,
      formationFilingNumber: rec?.formationFilingNumber ?? null,
      oaManifestVersion: rec?.oaManifestVersion ?? null,
      oaManifestAnchoredHash: rec?.oaManifestAnchoredHash ?? null,
      oaManifestPendingHash: manifestPendingHash,
      oaAmendmentExecutableAt: rec?.oaAmendmentExecutableAt ?? null,
    };
    d.repo.upsert(rec);
  }

  // ── Step 4: createEntity. Split into broadcast + confirm to close the create→persist double-mint
  //    window: persist the broadcast tx hash (status stays 'translating') BEFORE awaiting the receipt.
  //    On resume, a record that already carries a createTxHash ADOPTS that in-flight mint via confirm
  //    instead of broadcasting a second entity. Skip entirely once status is past 'translating'.
  if (rec.status === "translating") {
    let createTxHash = rec.createTxHash;
    if (!createTxHash) {
      createTxHash = await d.arc.broadcastCreateEntity({
        manager: rec.manager,
        guardian: rec.guardian,
        operator: rec.operator!,
        amendmentDelay: BigInt(rec.amendmentDelay),
        metadataURI: rec.metadataURI!,
        ein: rec.ein,
        formationDate: rec.formationDate,
        operatingAgreementHash: rec.oaHash!,
        treasury: rec.treasuryConfig!,
      });
      // Persist the broadcast hash before confirming. A crash between here and 'created' resumes by
      // adopting this tx (the line above is skipped because createTxHash is now set).
      rec = { ...rec, createTxHash };
      d.repo.upsert(rec);
    }
    // rec.manager is the manager this record was MINTED with. Passing it keeps the controller
    // assertion honest for a record broadcast before the controller cutover and resumed after it.
    const res = await d.arc.confirmCreateEntity(createTxHash, rec.manager as Address);
    const created: EntityRecord = {
      ...rec,
      status: "created",
      agentId: res.agentId.toString(),
      proxy: res.proxy,
      treasury: res.treasury,
      createTxHash: res.txHash,
      // The manifest v1 hash is now ON CHAIN (createEntity args[7]): pending becomes anchored, in
      // the same transaction as the entity row, so the DB can never claim an anchor the chain
      // does not hold. Legacy-scheme records carry no pending hash and are untouched here.
      ...(rec.oaManifestPendingHash
        ? {
            oaManifestVersion: OA_MANIFEST_VERSION_V1,
            oaManifestAnchoredHash: rec.oaManifestPendingHash,
            oaManifestPendingHash: null,
          }
        : {}),
    };
    rec = created;
    // Atomic: the entity row and its audit event commit together (or roll back together).
    d.repo.transaction(() => {
      d.repo.upsert(created);
      d.repo.recordEvent(
        key,
        "createEntity",
        "created",
        res.txHash,
        JSON.stringify({
          agentId: created.agentId,
          proxy: created.proxy,
          treasury: created.treasury,
        }),
      );
    });
  }

  // ── Step 5: bind wallet (operator signs, manager sends). Skip if already bound/funded.
  if (rec.status === "created") {
    const agentId = BigInt(rec.agentId!);
    const operator = rec.operator!;
    const deadline = await d.arc.walletSetDeadline();
    // Source the EIP-712 domain from the registry (eip712Domain()) so the off-chain digest can never
    // silently diverge from on-chain — works for the anvil mock and the live Arc registry alike.
    const domain = await d.arc.eip712Domain();
    const td = buildWalletSetTypedData({
      agentId,
      newWallet: operator,
      owner: rec.manager,
      deadline,
      chainId: d.arc.chainId,
      registry: d.arc.identityRegistry,
      domainName: domain.name,
      domainVersion: domain.version,
    });
    // Review M1: a circle record must NEVER fall through to the shared legacy signer — a resume
    // on a deployment whose Circle config was removed would otherwise sign the bind with a key
    // that has nothing to do with the SCA (opaque on-chain revert at best).
    if (rec.walletProvider === "circle" && !d.circleSignerForEntity)
      throw new Error(
        `circle-custody entity ${key} cannot bind: Circle signing is not configured on this deployment (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET)`,
      );
    // Provisioned path: build the per-entity signer — circle custody signs AgentWalletSet through
    // Circle as the operator SCA (ERC-1271; live-registry acceptance = the P2 known-unknown),
    // turnkey custody through the agent's own sub-org (the delegated Turnkey key signs only this
    // agent's wallet). Legacy path: the shared operatorSigner.
    const signer: OperatorSigner =
      rec.walletProvider === "circle" && rec.circleOperatorWalletId && d.circleSignerForEntity
        ? d.circleSignerForEntity({ operatorWalletId: rec.circleOperatorWalletId, operator })
        : rec.turnkeySubOrgId && d.signerForEntity
          ? await d.signerForEntity({ subOrgId: rec.turnkeySubOrgId, operator })
          : d.operatorSigner;
    const signature = await signer.signWalletSet(td);
    const txHash = await d.arc.setAgentWallet({
      agentId,
      newWallet: operator,
      deadline,
      signature,
      // The registry gates on the NFT's owner = this agent's manager. Relay only when that IS the
      // controller; a legacy agent's NFT is still owned by the old EOA and must be bound directly.
      agentManager: rec.manager as Address,
    });
    const bound: EntityRecord = { ...rec, status: "bound", bindTxHash: txHash };
    rec = bound;
    d.repo.transaction(() => {
      d.repo.upsert(bound);
      d.repo.recordEvent(
        key,
        "setAgentWallet",
        "bound",
        txHash,
        JSON.stringify({ agentWallet: operator }),
      );
    });
  }

  // ── Step 7 (optional): fund the treasury, then mark funded. Runs from "bound" (first fund) or
  //    "funded" (re-fund/top-up — audit fix B-safe: OnboardingRunner.fund now allows both statuses,
  //    so this must actually move USDC on a re-run instead of silently skipping it). Skip only if no
  //    amount was requested or the entity isn't funded/fundable yet.
  if (d.fundAmount && d.fundAmount > 0n && (rec.status === "bound" || rec.status === "funded")) {
    const txHash = await d.arc.fundTreasury({
      usdc: rec.treasuryConfig!.usdc,
      treasury: rec.treasury! as Address,
      amount: d.fundAmount,
    });
    d.outflows?.record("fund_treasury", d.fundAmount, txHash);
    const funded: EntityRecord = { ...rec, status: "funded", fundTxHash: txHash };
    rec = funded;
    d.repo.transaction(() => {
      d.repo.upsert(funded);
      d.repo.recordEvent(
        key,
        "fundTreasury",
        "funded",
        txHash,
        JSON.stringify({ amount: d.fundAmount?.toString() }),
      );
    });
  }

  // ── Step 8 (optional): ENSIP-25 reverse binding. Write the agent's ENS name onto the registry
  //    (getMetadata(agentId,"ens")) so it points back at <publicId>.<parent> — the reverse half of
  //    the bidirectional binding. Non-fatal and idempotent (skipped if already set); a failure here
  //    never blocks onboarding. Runs on every pass once agentId + publicId exist (resume-safe).
  if (d.ensParentName && rec.agentId && rec.publicId) {
    const ensName = `${rec.publicId}.${d.ensParentName}`;
    try {
      const current = await d.arc.getAgentMetadata(BigInt(rec.agentId), "ens");
      const already = current !== "0x" && hexToString(current) === ensName;
      if (!already) {
        const tx = await d.arc.setAgentMetadata(
          BigInt(rec.agentId),
          "ens",
          toHex(ensName),
          rec.manager as Address,
        );
        d.repo.recordEvent(key, "setEnsMetadata", rec.status, tx, JSON.stringify({ ens: ensName }));
      }
    } catch (e) {
      d.repo.recordEvent(
        key,
        "setEnsMetadata",
        rec.status,
        null,
        `ens binding skipped: ${(e as Error).message}`,
      );
    }
  }

  return rec;
}
