/**
 * The PR-1 anchor switch (design §4, completeness finding 1).
 *
 * NEW entities anchor the OA bundle MANIFEST hash at `createEntity`. The record that must NOT be
 * upgraded is one caught mid-onboarding by the deploy: it has already broadcast `createEntity`
 * with the legacy doc hash as an argument, so re-deriving its anchor on resume would silently
 * diverge the DB from the chain — a permanently unverifiable entity.
 *
 * Same fake-arc, no-chain style as onboarding.createWindow.test.ts: the point here is the
 * DERIVATION and what is persisted, not the on-chain leg.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { keccak256, toHex } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { computeOaHash, renderOperatingAgreement } from "../../src/oa/generator";
import { buildManifestV1, manifestHash, serializeManifest } from "../../src/oa/manifest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { translate } from "../../src/policy/translator";
import type { EntityRecord } from "../../src/types";
import { runOnboarding, usesManifestScheme } from "../../src/workflow/onboarding";

const USDC = "0x3600000000000000000000000000000000000000" as const;
const CHAIN_ID = 31337;

const spec = {
  name: "Anchor Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
    operator: "0x000000000000000000000000000000000000cCcc",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  legal: {},
  metadata: {},
} as unknown as AgentSpec;

const fakeSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsig",
} as unknown as OperatorSigner;

function makeFakeArc(opts: { confirmFails?: boolean } = {}) {
  let confirmShouldFail = opts.confirmFails ?? false;
  const broadcastCreateEntity = vi.fn(async () => "0xcreate0" as `0x${string}`);
  const confirmCreateEntity = vi.fn(async (txHash: string) => {
    if (confirmShouldFail) {
      confirmShouldFail = false;
      throw new Error("simulated confirm crash");
    }
    return {
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    };
  });
  const arc = {
    chainId: CHAIN_ID,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity,
    confirmCreateEntity,
    setAgentWallet: vi.fn(async () => "0xbind" as const),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let dir: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  dir = mkdtempSync(join(tmpdir(), "anchor-"));
  docStore = new FileDocumentStore(dir);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (arc: ArcAdapter, over: Record<string, unknown> = {}) => ({
  spec,
  idempotencyKey: "anchor-A",
  repo,
  docStore,
  arc,
  operatorSigner: fakeSigner,
  usdc: USDC,
  ownerTenantId: "t1",
  specJson: JSON.stringify(spec),
  metadataBaseUrl: "https://host.example/backend",
  ...over,
});

// ── The upgrade, for NEW entities ───────────────────────────────────────────────────────────

test("a FRESH entity anchors the MANIFEST hash, not the doc hash", async () => {
  const arc = makeFakeArc();
  const rec = await runOnboarding(deps(arc));

  const r = translate(spec, { usdc: USDC });
  const resolved = { ...r, operator: fakeSigner.address as `0x${string}` };
  const expected = manifestHash(
    buildManifestV1(spec, resolved, rec.publicId!, { chainId: CHAIN_ID, entityKey: "anchor-A" }),
  );
  expect(rec.oaHash).toBe(expected);
  // …and it is NOT the legacy derivation, which is the whole point of the change.
  expect(rec.oaHash).not.toBe(computeOaHash(renderOperatingAgreement(spec, resolved)));
  // What went ON CHAIN is what we persisted.
  expect(arc.broadcastCreateEntity).toHaveBeenCalledWith(
    expect.objectContaining({ operatingAgreementHash: expected }),
  );
});

test("createEntity confirm promotes v1 from PENDING to ANCHORED, in one row", async () => {
  const rec = await runOnboarding(deps(makeFakeArc()));
  expect(rec.oaManifestVersion).toBe(1);
  expect(rec.oaManifestAnchoredHash).toBe(rec.oaHash);
  // Cleared: nothing is in flight once the anchor is on chain (single-pending rule, §4).
  expect(rec.oaManifestPendingHash).toBeNull();
  const persisted = repo.findByIdempotencyKey("anchor-A")!;
  expect(persisted.oaManifestVersion).toBe(1);
  expect(persisted.oaManifestAnchoredHash).toBe(rec.oaHash);
  expect(persisted.oaManifestPendingHash).toBeNull();
});

test("the manifest is stored beside a VERSIONED terms doc, and its bytes re-hash to the anchor", async () => {
  const rec = await runOnboarding(deps(makeFakeArc()));
  const files = readdirSync(dir).sort();
  expect(files).toEqual(["manifest-anchor-A-v1.json", "meta-anchor-A.json", "oa-anchor-A-v1.md"]);
  // Re-read from DISK and re-hash: the anchored value must be reproducible from the stored
  // bytes alone, which is the entire promise a verifier holding only the chain relies on.
  const bytes = readFileSync(join(dir, "manifest-anchor-A-v1.json"));
  expect(keccak256(toHex(bytes.toString("utf8")))).toBe(rec.oaHash);
  const parsed = JSON.parse(bytes.toString("utf8"));
  expect(serializeManifest(parsed)).toBe(bytes.toString("utf8")); // already canonical on disk
  expect(parsed.schema).toBe("novi/oa-bundle/1");
  expect(parsed.chain.chainId).toBe(CHAIN_ID);
  expect(parsed.terms.uri).toBe("novi:doc:oa-anchor-A-v1.md");
  // terms.hash is the keccak of the terms doc actually written next to it.
  expect(parsed.terms.hash).toBe(
    computeOaHash(readFileSync(join(dir, "oa-anchor-A-v1.md"), "utf8")),
  );
  // The EIN line is gone from the terms doc: it is a legal FACT, carried by the manifest.
  expect(readFileSync(join(dir, "oa-anchor-A-v1.md"), "utf8")).not.toContain("EIN:");
});

// ── The guard: a record caught mid-onboarding by the deploy ────────────────────────────────

test("KEYSTONE: a record with a broadcast create tx keeps the LEGACY hash across the upgrade", async () => {
  // Reconstruct exactly what a PRE-upgrade deploy left behind: status 'translating', the create
  // tx already broadcast, and an oa_hash derived the OLD way. Its hash is an argument of a tx
  // that is already in flight — re-deriving it on resume would diverge DB from chain forever.
  const r = translate(spec, { usdc: USDC });
  const resolved = { ...r, operator: fakeSigner.address as `0x${string}` };
  const legacyDoc = renderOperatingAgreement(spec, resolved);
  const legacyHash = computeOaHash(legacyDoc);
  const midFlight: EntityRecord = {
    idempotencyKey: "anchor-A",
    name: spec.name,
    status: "translating",
    manager: r.manager,
    guardian: r.guardian,
    operator: resolved.operator,
    amendmentDelay: r.amendmentDelay.toString(),
    ein: r.legal.ein,
    formationDate: r.legal.formationDate,
    oaHash: legacyHash,
    metadataURI: "https://host.example/backend/metadata/legacy-public-id",
    publicId: "legacy-public-id",
    docPath: docStore.put("oa-anchor-A.md", legacyDoc).path,
    treasuryConfig: r.treasury,
    agentId: null,
    proxy: null,
    treasury: null,
    createTxHash: "0xcreate0", // <- BROADCAST. This is the whole guard.
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: "t1",
    error: null,
    specJson: JSON.stringify(spec),
    perTxCap: null,
  };
  repo.upsert(midFlight);

  const rec = await runOnboarding(deps(makeFakeArc()));

  expect(rec.oaHash).toBe(legacyHash); // untouched by the upgrade
  expect(rec.oaManifestVersion).toBeNull(); // never joins the manifest scheme
  expect(rec.oaManifestPendingHash).toBeNull();
  expect(rec.oaManifestAnchoredHash).toBeNull();
  // No manifest was written for it, and the legacy doc name is the one that stays.
  expect(readdirSync(dir).sort()).toEqual(["meta-anchor-A.json", "oa-anchor-A.md"]);
  // The saga adopted the in-flight tx rather than re-broadcasting (createWindow's rule, intact).
  expect(rec.createTxHash).toBe("0xcreate0");
  expect(rec.status).toBe("bound");
});

test("STICKY the other way: a manifest record that crashed after broadcast stays on the manifest", async () => {
  // Without a sticky marker, the translating-resume would see `createTxHash != null` and flip
  // BACK to the legacy derivation — diverging in the opposite direction, and just as fatally.
  const arc = makeFakeArc({ confirmFails: true });
  await expect(runOnboarding(deps(arc))).rejects.toThrow(/simulated confirm crash/);
  const mid = repo.findByIdempotencyKey("anchor-A")!;
  expect(mid.status).toBe("translating");
  expect(mid.createTxHash).toBe("0xcreate0");
  expect(mid.oaManifestPendingHash).toBe(mid.oaHash); // the marker, written before the broadcast
  const anchorBefore = mid.oaHash;

  const rec = await runOnboarding(deps(arc));
  expect(rec.oaHash).toBe(anchorBefore); // the value already on chain — unchanged
  expect(rec.oaManifestVersion).toBe(1);
  expect(rec.oaManifestAnchoredHash).toBe(anchorBefore);
  expect(arc.broadcastCreateEntity).toHaveBeenCalledTimes(1); // adopted, never re-minted
});

test("usesManifestScheme: the predicate itself, at each of its three decision points", () => {
  expect(usesManifestScheme(undefined)).toBe(true); // brand-new record
  expect(
    usesManifestScheme({
      createTxHash: null,
      oaManifestVersion: null,
      oaManifestPendingHash: null,
    }),
  ).toBe(true);
  // Broadcast without a manifest marker = a pre-upgrade record: legacy, forever.
  expect(
    usesManifestScheme({
      createTxHash: "0xabc",
      oaManifestVersion: null,
      oaManifestPendingHash: null,
    }),
  ).toBe(false);
  // Broadcast WITH a marker (either one) = a manifest record mid-window: still manifest.
  expect(
    usesManifestScheme({
      createTxHash: "0xabc",
      oaManifestVersion: null,
      oaManifestPendingHash: "0xdead",
    }),
  ).toBe(true);
  expect(
    usesManifestScheme({
      createTxHash: "0xabc",
      oaManifestVersion: 1,
      oaManifestPendingHash: null,
    }),
  ).toBe(true);
});

// ── Formation pinning (custody twin) ────────────────────────────────────────────────────────

test("formation provider + environment are pinned from config on a FRESH record", async () => {
  const rec = await runOnboarding(
    deps(makeFakeArc(), { formation: { provider: "doola", environment: "sandbox" } }),
  );
  expect(rec.formationProvider).toBe("doola");
  expect(rec.formationEnvironment).toBe("sandbox");
  expect(repo.findByIdempotencyKey("anchor-A")?.formationEnvironment).toBe("sandbox");
});

test("a credential-less deployment leaves the pair NULL — stub mode, nothing else changes", async () => {
  const rec = await runOnboarding(deps(makeFakeArc()));
  expect(rec.formationProvider).toBeNull();
  expect(rec.formationEnvironment).toBeNull();
  expect(rec.status).toBe("bound"); // the saga is otherwise untouched
});

test("a PERSISTED environment wins over config — a flip cannot re-point an in-flight entity", async () => {
  // Claim the row pinned to sandbox…
  await runOnboarding(
    deps(makeFakeArc(), { formation: { provider: "doola", environment: "sandbox" } }),
  );
  // …then resume the SAME key on a deployment that now says production (the mainnet flip).
  const rec = await runOnboarding(
    deps(makeFakeArc(), { formation: { provider: "doola", environment: "production" } }),
  );
  expect(rec.formationEnvironment).toBe("sandbox");
  expect(repo.findByIdempotencyKey("anchor-A")?.formationEnvironment).toBe("sandbox");
});
