import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";

/** Tier-0 P1d — the custody fork in the onboarding saga: circle custody provisions the per-agent
 *  Circle wallets (SCA operator + EOA pocket) instead of a Turnkey sub-org, binds via the circle
 *  signer, and persists the custody fields the P1c dispatch reads. */

const SCA = "0x00000000000000000000000000000000000005CA";
const POCKET = "0x0000000000000000000000000000000000000Ec0";

const spec = {
  name: "Custody Agent",
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

const sharedSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsharedsig",
} as unknown as OperatorSigner;

function makeFakeArc() {
  const setAgentWallet = vi.fn(async () => "0xbind" as const);
  const arc = {
    chainId: 31337,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity: vi.fn(async () => "0xcreate" as `0x${string}`),
    confirmCreateEntity: vi.fn(async (txHash: string) => ({
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    })),
    setAgentWallet,
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(`/tmp/legalbody-custody-${Math.floor(performance.now())}`);
});
afterEach(() => db.close());

function makeCircleSeams() {
  const provisionCircle = vi.fn(async ({ entityKey }: { entityKey: string; name: string }) => ({
    operator: SCA,
    operatorWalletId: `op-${entityKey}`,
    pocketWalletId: `pk-${entityKey}`,
    pocketAddress: POCKET,
    walletSetId: "ws-1",
  }));
  const circleSign = vi.fn(async () => "0xcirclesig" as `0x${string}`);
  const circleSignerForEntity = vi.fn((e: { operatorWalletId: string; operator: string }) => ({
    address: e.operator as `0x${string}`,
    signWalletSet: circleSign,
  }));
  const turnkeyProvision = vi.fn(async () => {
    throw new Error("turnkey provisioning must not run on the circle path");
  });
  return { provisionCircle, circleSign, circleSignerForEntity, turnkeyProvision };
}

const baseDeps = (arc: ArcAdapter) => ({
  spec,
  idempotencyKey: "cust-A",
  repo,
  docStore,
  arc,
  operatorSigner: sharedSigner,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  ownerTenantId: "t1",
  specJson: JSON.stringify(spec),
  metadataBaseUrl: "https://host.example/backend",
});

test("circle custody: provisions SCA+pocket, binds via the circle signer, persists custody fields", async () => {
  const arc = makeFakeArc();
  const seams = makeCircleSeams();
  const rec = await runOnboarding({
    ...baseDeps(arc),
    custody: "circle",
    provisionCircle: seams.provisionCircle,
    circleSignerForEntity: seams.circleSignerForEntity,
    provision: seams.turnkeyProvision, // present but must NOT be invoked
    guardianPasskey: { attestation: { credentialId: "cred-1" } } as never,
  });

  expect(rec.status).toBe("bound");
  expect(seams.provisionCircle).toHaveBeenCalledTimes(1);
  expect(seams.turnkeyProvision).not.toHaveBeenCalled();
  // The SCA IS the on-chain operator, and the bind was signed through Circle (not the shared key).
  expect(rec.operator).toBe(SCA);
  expect(seams.circleSign).toHaveBeenCalledTimes(1);
  const bindArgs = (arc.setAgentWallet as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  expect(bindArgs).toMatchObject({ newWallet: SCA });
  // Custody fields the P1c dispatch reads, all persisted.
  const stored = repo.findByIdempotencyKey("cust-A")!;
  expect(stored.walletProvider).toBe("circle");
  expect(stored.circleOperatorWalletId).toBe("op-cust-A");
  expect(stored.circlePocketWalletId).toBe("pk-cust-A");
  expect(stored.pocketAddress).toBe(POCKET);
  expect(stored.circleWalletSetId).toBe("ws-1");
  expect(stored.turnkeySubOrgId ?? null).toBeNull();
});

test("circle resume MID-SAGA: persisted provider beats a contradicting custody input — no turnkey re-provision, bind stays circle-signed", async () => {
  // First run crashes AFTER circle provisioning (broadcast throws) → record persists mid-saga.
  const brokenArc = makeFakeArc();
  (brokenArc.broadcastCreateEntity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    new Error("simulated crash"),
  );
  const seams = makeCircleSeams();
  const deps = {
    ...baseDeps(brokenArc),
    custody: "circle" as const,
    provisionCircle: seams.provisionCircle,
    circleSignerForEntity: seams.circleSignerForEntity,
  };
  await expect(runOnboarding(deps)).rejects.toThrow("simulated crash");
  expect(repo.findByIdempotencyKey("cust-A")?.walletProvider).toBe("circle");

  // Resume with a CONTRADICTING custody input AND live turnkey seams — if the input won, the
  // turnkey Step 0 would provision a sub-org and flip the operator. The persisted provider wins.
  const rec = await runOnboarding({
    ...deps,
    custody: "turnkey",
    provision: seams.turnkeyProvision, // throws if invoked
    guardianPasskey: { attestation: { credentialId: "cred-1" } } as never,
    signerForEntity: async () => sharedSigner,
  });
  expect(seams.provisionCircle).toHaveBeenCalledTimes(1); // no circle re-provision either
  expect(seams.turnkeyProvision).not.toHaveBeenCalled();
  expect(rec.status).toBe("bound");
  expect(rec.walletProvider).toBe("circle");
  expect(rec.operator).toBe(SCA);
  expect(seams.circleSign).toHaveBeenCalledTimes(1); // bind went through the CIRCLE signer
});

test("circle custody without provisioning configured refuses with a NAMED error", async () => {
  const arc = makeFakeArc();
  await expect(runOnboarding({ ...baseDeps(arc), custody: "circle" })).rejects.toThrow(
    /circle custody.*no Circle provisioning configured/s,
  );
  // Nothing minted, nothing bound.
  expect(arc.broadcastCreateEntity).not.toHaveBeenCalled();
});

test("turnkey custody records walletProvider + creation-time pocket address", async () => {
  const arc = makeFakeArc();
  const provision = vi.fn(async () => ({
    subOrgId: "sub-1",
    walletId: "w-1",
    operator: "0x000000000000000000000000000000000000cCcc",
  }));
  const rec = await runOnboarding({
    ...baseDeps(arc),
    custody: "turnkey",
    provision,
    guardianPasskey: { attestation: { credentialId: "cred-1" } } as never,
    signerForEntity: async () => sharedSigner,
    derivePocketAddress: (k) => `0xpocket-${k}`,
  });
  expect(rec.status).toBe("bound");
  expect(provision).toHaveBeenCalledTimes(1);
  const stored = repo.findByIdempotencyKey("cust-A")!;
  expect(stored.walletProvider).toBe("turnkey");
  expect(stored.pocketAddress).toBe("0xpocket-cust-A");
});

test("legacy shared-key path (no custody, no provisioning) still works and stores a pocket address when derivable", async () => {
  const arc = makeFakeArc();
  const rec = await runOnboarding({
    ...baseDeps(arc),
    derivePocketAddress: (k) => `0xpocket-${k}`,
  });
  expect(rec.status).toBe("bound");
  expect(rec.walletProvider ?? null).toBeNull(); // legacy rows stay null (reads as turnkey)
  expect(rec.pocketAddress).toBe("0xpocket-cust-A");
});
