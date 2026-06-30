import type { Address } from "viem";
import type { ArcAdapter } from "../adapters/arc/arcAdapter";
import { buildWalletSetTypedData } from "../adapters/arc/walletSet";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import type { OperatorSigner } from "../adapters/turnkey/signer";
import { computeOaHash, renderMetadata, renderOperatingAgreement } from "../oa/generator";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { AgentSpec } from "../policy/agentSpec";
import { assertOperatorDistinct, translate } from "../policy/translator";
import { usdToUnits } from "../policy/units";
import type { EntityRecord } from "../types";

/** Result of provisioning a per-agent Turnkey vault (the saga only needs these three fields). */
export interface ProvisionedVault {
  subOrgId: string;
  walletId: string;
  operator: string;
}

export interface OnboardingDeps {
  spec: AgentSpec;
  idempotencyKey: string;
  repo: EntityRepository;
  docStore: DocumentStore;
  arc: ArcAdapter;
  operatorSigner: OperatorSigner;
  usdc: Address; // default USDC for the translator
  /** Owning tenant (controller wallet address); persisted on every record the saga writes. */
  ownerTenantId?: string;
  /** Validated AgentSpec JSON; persisted so the reconciler/fund can re-run the saga. */
  specJson?: string;
  fundAmount?: bigint; // optional: top up the treasury after binding (status -> funded)
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

  // ── Step 0 (optional): provision the per-agent Turnkey vault BEFORE minting. Triggered only when a
  //    `provision` seam + a `guardianPasskey` are supplied. Idempotent: on resume, a record that
  //    already carries `turnkeySubOrgId` is NOT re-provisioned (no second sub-org) — its stored
  //    sub-org id + operator are reused for createEntity/bind below. 'provisioned' precedes 'created'.
  if (d.provision && d.guardianPasskey && !rec?.turnkeySubOrgId) {
    const vault = await d.provision({
      subOrgName: d.spec.name,
      guardianPasskey: d.guardianPasskey,
    });
    const provisioned: EntityRecord = rec
      ? {
          ...rec,
          status: "provisioned",
          operator: vault.operator as Address,
          turnkeySubOrgId: vault.subOrgId,
          turnkeyWalletId: vault.walletId,
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
          ownerTenantId: d.ownerTenantId,
          error: null,
          specJson: d.specJson ?? null,
          perTxCap: null,
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
    // Provisioned path: the operator is the per-agent Turnkey key persisted in Step 0. Legacy path:
    // the shared operatorSigner's address. (rec.turnkeySubOrgId set => provisioned.)
    const operator = rec?.turnkeySubOrgId ? rec.operator! : d.operatorSigner.address;
    assertOperatorDistinct(r, operator); // operator now known -> full distinctness check
    const resolved = { ...r, operator };
    const doc = renderOperatingAgreement(d.spec, resolved);
    const oaHash = computeOaHash(doc);
    const meta = renderMetadata(d.spec, resolved, oaHash);
    const docPut = d.docStore.put(`oa-${key}.md`, doc);
    const metaPut = d.docStore.put(`meta-${key}.json`, JSON.stringify(meta, null, 2));

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
      metadataURI: metaPut.uri,
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
      // Carry the Step-0 vault ids forward (undefined on the legacy path).
      turnkeySubOrgId: rec?.turnkeySubOrgId,
      turnkeyWalletId: rec?.turnkeyWalletId,
      ownerTenantId: d.ownerTenantId ?? rec?.ownerTenantId,
      error: null,
      specJson: d.specJson ?? rec?.specJson ?? null,
      perTxCap:
        d.spec.treasury.perTxCapUsdc != null ? usdToUnits(d.spec.treasury.perTxCapUsdc) : null,
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
    const res = await d.arc.confirmCreateEntity(createTxHash);
    const created: EntityRecord = {
      ...rec,
      status: "created",
      agentId: res.agentId.toString(),
      proxy: res.proxy,
      treasury: res.treasury,
      createTxHash: res.txHash,
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
    // Provisioned path: build the per-entity signer from the agent's own sub-org (the delegated
    // Turnkey key signs only this agent's wallet). Legacy path: the shared operatorSigner.
    const signer: OperatorSigner =
      rec.turnkeySubOrgId && d.signerForEntity
        ? await d.signerForEntity({ subOrgId: rec.turnkeySubOrgId, operator })
        : d.operatorSigner;
    const signature = await signer.signWalletSet(td);
    const txHash = await d.arc.setAgentWallet({
      agentId,
      newWallet: operator,
      deadline,
      signature,
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

  // ── Step 7 (optional): fund the treasury, then mark funded. Skip if no amount or already funded.
  if (d.fundAmount && d.fundAmount > 0n && rec.status === "bound") {
    const txHash = await d.arc.fundTreasury({
      usdc: rec.treasuryConfig!.usdc,
      treasury: rec.treasury! as Address,
      amount: d.fundAmount,
    });
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

  return rec;
}
