/**
 * The B+ loop against a REAL LegalManager on anvil (design §11, "Integration").
 *
 * Everything else about the anchor sub-saga is tested against a fake chain that reproduces the
 * contract's four awkward properties. This test exists because a fake can only reproduce the
 * properties we KNOW about: here the manifest is written, its keccak goes through the real
 * `scheduleOperatingAgreementUpdate`, the real timelock elapses, the real
 * `executeOperatingAgreementUpdate` runs, and the assertion is on `meta().operatingAgreementHash`
 * read back off the chain.
 *
 * The veto branch is the other half, and it is driven by the GUARDIAN's own key — not by mutating
 * state — because "a veto parks the entity's whole pipeline" is only meaningful if the veto is the
 * one the contract performs.
 */
import type Database from "better-sqlite3";
import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { legalManagerAbi } from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import {
  buildManifestV1,
  manifestDocName,
  manifestHash,
  parseManifest,
  serializeManifestBytes,
} from "../../src/oa/manifest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";
import { parseAgentSpec } from "../../src/policy/agentSpec";
import { translate } from "../../src/policy/translator";
import type { Address, EntityRecord, Hex } from "../../src/types";
import { type AnchorLoopDeps, advanceAnchor } from "../../src/workflow/anchorLoop";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { MemoryDocumentStore, formedEntity } from "../helpers/formationFakes";
import { deployStack } from "../helpers/stack";

const ACCT = (i: number) =>
  privateKeyToAccount(
    [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ][i] as Hex,
  );

const manager = ACCT(0);
const guardianAcct = ACCT(1);
const operator = ACCT(2).address;
const payout = ACCT(3).address;
/** The contract's own floor is 1 hour; anything shorter reverts `DelayTooShort`. */
const AMENDMENT_DELAY = 3_600n;

const SPEC = parseAgentSpec({
  name: "Anvil Anchor Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: manager.address,
    guardian: guardianAcct.address,
    operator,
  },
  treasury: {
    payoutAddress: payout,
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "1h" },
});

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let pub: PublicClient;
let guardianWallet: WalletClient;

let db: Database.Database;
let repo: SqliteEntityRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let anchors: SqliteOaAnchorRepository;
let docStore: MemoryDocumentStore;
let clock: number;
let seq = 0;

function deps(): AnchorLoopDeps {
  return {
    repo,
    requests,
    documents,
    docStore,
    anchors,
    arc: adapter,
    chainId: anvilChain.id,
    environment: "sandbox",
    now: () => clock,
  };
}

/** Anvil's clock, and ours, moved together — the backend's due gate is in ms, the chain's in
 *  seconds, and a test that moved only one of them would prove nothing. */
async function warp(seconds: number): Promise<void> {
  await fetch(anvil.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "evm_increaseTime",
      params: [seconds],
    }),
  });
  await fetch(anvil.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
  });
  clock += seconds * 1000;
}

/**
 * Mint a REAL entity whose on-chain anchor is a REAL v1 manifest, then record it the way the
 * onboarding saga records it. The v1 hash is the `operatingAgreementHash` argument of the very
 * `createEntity` call that mints the proxy — which is exactly why v1's `chain` fields are null.
 */
async function mintAnchoredEntity(): Promise<{ key: string; v1Hash: Hex; rec: EntityRecord }> {
  const key = `tenant-a:anvil-${++seq}`;
  const r = translate(SPEC, { usdc: stack.usdc });
  const manifest = buildManifestV1(
    SPEC,
    r,
    `pub-${seq}`,
    { chainId: anvilChain.id, entityKey: key },
    "# Operating Agreement\n",
  );
  const bytes = serializeManifestBytes(manifest);
  const v1Hash = manifestHash(bytes);
  docStore.putBytes(manifestDocName(key, 1), bytes);

  const res = await adapter.createEntity({
    manager: manager.address,
    guardian: guardianAcct.address,
    operator,
    amendmentDelay: AMENDMENT_DELAY,
    metadataURI: `file:///tmp/${key}.json`,
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    operatingAgreementHash: v1Hash,
    treasury: {
      usdc: stack.usdc,
      payoutAddress: payout,
      cap: 1_000_000n,
      period: 2_592_000n,
      allowlistEnabled: false,
    },
  });

  const rec = formedEntity({
    idempotencyKey: key,
    publicId: `pub-${seq}`,
    manager: manager.address,
    guardian: guardianAcct.address,
    operator,
    agentId: res.agentId.toString(),
    proxy: res.proxy,
    treasury: res.treasury,
    createTxHash: res.txHash,
    oaHash: v1Hash,
    oaManifestVersion: 1,
    oaManifestAnchoredHash: v1Hash,
  });
  repo.upsert(rec);
  requests.claimAllSteps(key);
  requests.transition(key, "create_provider", "pending", "confirmed", {
    providerRef: `cmp-${seq}`,
  });
  return { key, v1Hash, rec };
}

/** The v2 trigger: the state filed the company and both required documents are indexed. */
function confirmFiling(key: string): void {
  requests.transition(key, "await_filing", "pending", "confirmed");
  requests.transition(key, "fetch_documents", "pending", "confirmed");
  const rec = repo.findByIdempotencyKey(key)!;
  repo.upsert({ ...rec, formationFiledAt: 1_755_600_000, formationFilingNumber: "2026-0001" });
  for (const [type, sha] of [
    ["ArticlesOfOrganization", "a".repeat(64)],
    ["OperatingAgreement", "b".repeat(64)],
  ] as const)
    documents.insert({
      id: documentIndexId(key, type),
      entityKey: key,
      docType: type,
      sha256: sha,
      contentType: "application/pdf",
      size: 2048,
      providerDocId: type,
      path: `doc-${key}-${type}.pdf`,
    });
}

beforeAll(async () => {
  anvil = await startAnvil(8552);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  guardianWallet = createWalletClient({ account: guardianAcct, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
}, 60_000);
afterAll(() => anvil?.stop());

beforeEach(async () => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  anchors = new SqliteOaAnchorRepository(db);
  docStore = new MemoryDocumentStore();
  const block = await pub.getBlock({ blockTag: "latest" });
  clock = Number(block.timestamp) * 1000;
});

test("A-int-1: v1 -> facts -> v2 scheduled -> timelock -> executed, and meta() IS keccak(manifest v2)", async () => {
  const { key, v1Hash } = await mintAnchoredEntity();
  const rec = repo.findByIdempotencyKey(key)!;
  const proxy = rec.proxy as Address;

  // The chain starts where createEntity left it: anchored at v1.
  expect(await adapter.oaCurrentHash(proxy)).toBe(v1Hash);
  expect(await adapter.oaAmendmentDelay(proxy)).toBe(AMENDMENT_DELAY);

  confirmFiling(key);
  const scheduled = await advanceAnchor(deps(), key);
  expect(scheduled).toMatchObject({ advanced: true, version: 2, state: "scheduled" });

  const row = anchors.find(key, 2)!;
  // The scheduled hash is the keccak of the bytes on disk — not a value the loop carried in memory.
  const storedBytes = docStore.getBytes(manifestDocName(key, 2));
  expect(manifestHash(storedBytes)).toBe(row.manifestHash);
  expect(parseManifest(storedBytes).previous).toBe(v1Hash);
  // …and the CHAIN agrees about when it may be executed.
  expect(await adapter.oaScheduledAt(proxy, row.manifestHash)).toBe(BigInt(row.executableAt!));
  expect(await adapter.oaCurrentHash(proxy)).toBe(v1Hash); // nothing has landed yet

  // Too early: the real contract reverts TooEarly, so the loop must not even try.
  expect(await advanceAnchor(deps(), key)).toMatchObject({ skipped: "not_due" });
  expect(await adapter.oaCurrentHash(proxy)).toBe(v1Hash);

  await warp(Number(AMENDMENT_DELAY) + 60);
  const executed = await advanceAnchor(deps(), key);
  expect(executed).toMatchObject({ advanced: true, version: 2, state: "executed" });

  // THE assertion this whole file exists for.
  expect(await adapter.oaCurrentHash(proxy)).toBe(manifestHash(storedBytes));
  const e = repo.findByIdempotencyKey(key)!;
  expect(e.oaManifestVersion).toBe(2);
  expect(e.oaManifestAnchoredHash).toBe(row.manifestHash);
  expect(e.oaHash).toBe(row.manifestHash);
  expect(e.oaManifestPendingHash).toBeNull();
  // `scheduledAt` was DELETED by the execute — the ambiguity the recovery rules are written for.
  expect(await adapter.oaScheduledAt(proxy, row.manifestHash)).toBe(0n);

  // Idempotent: a second pass on a fully anchored entity does nothing at all.
  expect(await advanceAnchor(deps(), key)).toMatchObject({ advanced: false });
}, 90_000);

test("A-int-2: a real guardian veto parks the pipeline; liftVeto resumes it", async () => {
  const { key, v1Hash } = await mintAnchoredEntity();
  const proxy = repo.findByIdempotencyKey(key)!.proxy as Address;
  confirmFiling(key);
  await advanceAnchor(deps(), key);
  const v2Hash = anchors.find(key, 2)!.manifestHash;

  // The guardian acts, with their own key, through the contract — not by mutating state.
  const vetoTx = await guardianWallet.writeContract({
    address: proxy,
    abi: legalManagerAbi,
    functionName: "cancelOperatingAgreementUpdate",
    args: [v2Hash],
    account: guardianAcct,
    chain: anvilChain,
  });
  await pub.waitForTransactionReceipt({ hash: vetoTx });
  expect(await adapter.oaVetoed(proxy, v2Hash)).toBe(true);
  // The contract deleted the schedule too, so `scheduledAt == 0` while `meta` is still v1 — the
  // exact ambiguity the loop must not read as "already executed".
  expect(await adapter.oaScheduledAt(proxy, v2Hash)).toBe(0n);

  await warp(Number(AMENDMENT_DELAY) + 60);
  expect(await advanceAnchor(deps(), key)).toMatchObject({ version: 2, state: "vetoed" });
  expect(await adapter.oaCurrentHash(proxy)).toBe(v1Hash);

  // The whole pipeline is parked: new facts do NOT get routed around the guardian.
  requests.transition(key, "await_ein", "pending", "confirmed");
  repo.upsert({ ...repo.findByIdempotencyKey(key)!, einReal: "88-1234567" });
  expect(await advanceAnchor(deps(), key)).toMatchObject({ skipped: "hold_park" });
  expect(anchors.versionsOf(key).map((c) => c.version)).toEqual([2]);

  // The guardian re-allows it; the newest facts are what get anchored.
  const liftTx = await guardianWallet.writeContract({
    address: proxy,
    abi: legalManagerAbi,
    functionName: "liftVeto",
    args: [v2Hash],
    account: guardianAcct,
    chain: anvilChain,
  });
  await pub.waitForTransactionReceipt({ hash: liftTx });

  const resumed = await advanceAnchor(deps(), key);
  expect(resumed).toMatchObject({ version: 3, state: "scheduled" });
  expect(anchors.find(key, 2)!.state).toBe("superseded");
  expect(parseManifest(docStore.getBytes(manifestDocName(key, 3))).legal?.ein).toBe("88-1234567");

  await warp(Number(AMENDMENT_DELAY) + 60);
  await advanceAnchor(deps(), key);
  expect(await adapter.oaCurrentHash(proxy)).toBe(anchors.find(key, 3)!.manifestHash);
  expect(repo.findByIdempotencyKey(key)!.oaManifestVersion).toBe(3);
  // The vetoed hash was never anchored, and never re-proposed.
  expect(await adapter.oaVetoed(proxy, v2Hash)).toBe(false);
  expect(await adapter.oaScheduledAt(proxy, v2Hash)).toBe(0n);
}, 90_000);
