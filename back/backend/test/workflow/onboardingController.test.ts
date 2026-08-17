/**
 * The setAgentWallet EIP-712 `owner` field under NoviController mode (design §3/§5).
 *
 * The registry verifies a signature over
 *   AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)
 * where `owner` is the NFT owner making the call. In controller mode that is the CONTROLLER, not the
 * signing key — and the value travels a long way to get there: CONTROLLER_ADDRESS -> config ->
 * platformManagerAddress() -> forced into spec.roles.manager on both onboard doors -> rec.manager ->
 * `owner` in the typed data (onboarding.ts). One wrong link and every bind reverts "invalid wallet
 * sig", so the whole chain is asserted end to end here.
 */
import type Database from "better-sqlite3";
import type { TypedDataDefinition } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { managerAccount, platformManagerAddress } from "../../src/adapters/arc/clients";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { loadConfig } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { type AgentSpec, parseAgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";

const CONTROLLER = "0x4819bd1e7f5F1e2b0e07A2E4f3d0B3E1C2A4f6e0";
const FACTORY = "0x1234567890AbcdEF1234567890aBcdef12345678";
const OPERATOR = "0x000000000000000000000000000000000000cCcc";
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const env = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  FACTORY_ADDRESS: FACTORY,
};

/** The spec both onboard doors build: roles.manager is FORCED to the platform manager address. */
const specWithManager = (manager: string): AgentSpec =>
  parseAgentSpec({
    name: "Controller Agent",
    roles: { manager, guardian: "0x000000000000000000000000000000000000bBbb" },
    treasury: {
      payoutAddress: "0x000000000000000000000000000000000000dDdd",
      spendingCapUsdc: "100.00",
      spendingPeriod: "24h",
      allowlistEnabled: false,
    },
    governance: { amendmentDelay: "24h" },
  });

function makeFakeArc() {
  const captured: TypedDataDefinition[] = [];
  const minted: { manager?: string } = {};
  const arc = {
    chainId: 5042002,
    identityRegistry: REGISTRY,
    broadcastCreateEntity: vi.fn(async (p: { manager: string }) => {
      minted.manager = p.manager;
      return "0xcreate" as `0x${string}`;
    }),
    confirmCreateEntity: vi.fn(async (txHash: string, _agentManager?: string) => ({
      agentId: 876734n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    })),
    setAgentWallet: vi.fn(async () => "0xbind" as const),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "ERC8004IdentityRegistry", version: "1" })),
  };
  const signer = {
    address: OPERATOR,
    signWalletSet: vi.fn(async (td: TypedDataDefinition) => {
      captured.push(td);
      return "0xsig" as `0x${string}`;
    }),
  } as unknown as OperatorSigner;
  return { arc: arc as unknown as ArcAdapter & typeof arc, signer, captured, minted };
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(`/tmp/legalbody-controller-${Math.floor(performance.now())}`);
});
afterEach(() => db.close());

test("controller mode: the AgentWalletSet signature commits to owner == CONTROLLER", async () => {
  const cfg = loadConfig({ ...env, CONTROLLER_ADDRESS: CONTROLLER });
  const manager = platformManagerAddress(cfg); // what both onboard doors force into roles.manager
  expect(manager).toBe(cfg.controllerAddress);

  const { arc, signer, captured, minted } = makeFakeArc();
  const rec = await runOnboarding({
    spec: specWithManager(manager),
    idempotencyKey: "ctrl-A",
    repo,
    docStore,
    arc,
    operatorSigner: signer,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t1",
    metadataBaseUrl: "https://api.example/backend",
  });

  expect(rec.status).toBe("bound");
  expect(rec.manager).toBe(CONTROLLER); // persisted identity is the contract, not the key
  expect(captured).toHaveLength(1);
  const td = captured[0]!;
  expect(td.message).toMatchObject({
    agentId: 876734n,
    newWallet: OPERATOR,
    owner: CONTROLLER, // ← the field the whole design turns on
    deadline: 9_999_999_999n,
  });
  // The signature is still produced by the OPERATOR (newWallet) — only `owner` moved.
  expect(td.message.newWallet).toBe(signer.address);
  expect(td.message.owner).not.toBe(managerAccount(cfg).address);
  // createEntity mints to the same manager identity.
  expect(minted.manager).toBe(CONTROLLER);
});

test("legacy mode: owner is still the signing key's address (unchanged behavior)", async () => {
  const cfg = loadConfig(env);
  const manager = platformManagerAddress(cfg);
  expect(manager).toBe(managerAccount(cfg).address);

  const { arc, signer, captured } = makeFakeArc();
  await runOnboarding({
    spec: specWithManager(manager),
    idempotencyKey: "legacy-A",
    repo,
    docStore,
    arc,
    operatorSigner: signer,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t1",
    metadataBaseUrl: "https://api.example/backend",
  });
  expect(captured[0]!.message.owner).toBe(managerAccount(cfg).address);
});

/**
 * Resume ACROSS the controller cutover (design §5).
 *
 * A create broadcast before the flip is already on chain, minted with the OLD manager EOA. The
 * saga resumes from the PERSISTED spec (runner.reconcileInFlight rehydrates rec.specJson), so the
 * manager it confirms against must be the one the mint actually used — not the controller this
 * deployment now runs with. Confirming with the wrong one throws "is not the configured
 * controller" on every retry and strands the record at `translating` forever.
 */
test("a create broadcast pre-flip confirms against the manager it was MINTED with", async () => {
  const cfg = loadConfig(env); // pre-flip: no controller
  const mintedManager = managerAccount(cfg).address;
  const spec = specWithManager(mintedManager);
  const common = {
    idempotencyKey: "resume-across-flip",
    repo,
    docStore,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t1",
    metadataBaseUrl: "https://api.example/backend",
  } as const;

  // Pass 1: broadcast lands, the receipt never arrives — the crash the split exists to survive.
  const first = makeFakeArc();
  first.arc.confirmCreateEntity.mockRejectedValueOnce(new Error("receipt timeout"));
  await expect(
    runOnboarding({ ...common, spec, arc: first.arc, operatorSigner: first.signer }),
  ).rejects.toThrow(/receipt timeout/);
  const stranded = repo.findByIdempotencyKey(common.idempotencyKey);
  expect(stranded?.status).toBe("translating");
  expect(stranded?.createTxHash).toBe("0xcreate"); // the hash is persisted, ready to be adopted
  expect(stranded?.manager).toBe(mintedManager);

  // Pass 2: the deployment has since flipped to controller mode. The saga replays the PERSISTED
  // spec, so the manager of record is still the old EOA.
  const second = makeFakeArc();
  const rec = await runOnboarding({
    ...common,
    spec,
    arc: second.arc,
    operatorSigner: second.signer,
  });

  expect(second.arc.broadcastCreateEntity).not.toHaveBeenCalled(); // adopted, not re-minted
  expect(second.arc.confirmCreateEntity).toHaveBeenCalledWith("0xcreate", mintedManager);
  expect(rec.status).toBe("bound");
  // The bind of a legacy agent is likewise attributed to its own manager, so the adapter sends it
  // direct instead of relaying it into a NotManager revert.
  expect(second.arc.setAgentWallet).toHaveBeenCalledWith(
    expect.objectContaining({ agentManager: mintedManager }),
  );
});

test("a controller-managed agent threads the CONTROLLER as its manager everywhere", async () => {
  const cfg = loadConfig({ ...env, CONTROLLER_ADDRESS: CONTROLLER });
  const manager = platformManagerAddress(cfg);
  const { arc, signer } = makeFakeArc();
  await runOnboarding({
    spec: specWithManager(manager),
    idempotencyKey: "ctrl-thread",
    repo,
    docStore,
    arc,
    operatorSigner: signer,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t1",
    metadataBaseUrl: "https://api.example/backend",
  });
  expect(arc.confirmCreateEntity).toHaveBeenCalledWith("0xcreate", CONTROLLER);
  expect(arc.setAgentWallet).toHaveBeenCalledWith(
    expect.objectContaining({ agentManager: CONTROLLER }),
  );
});
