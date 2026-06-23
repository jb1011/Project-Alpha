import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const spec = {
  name: "Tenant Agent",
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

// Structural fake ArcAdapter: just enough for the legacy (no-passkey) saga path.
const fakeArc = {
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  createEntity: async () => ({
    agentId: 7n,
    proxy: "0x00000000000000000000000000000000000000Ef",
    treasury: "0x00000000000000000000000000000000000000Fe",
    txHash: "0xaa",
  }),
  walletSetDeadline: async () => 9999999999n,
  eip712Domain: async () => ({ name: "ERC8004IdentityRegistry", version: "1" }),
  setAgentWallet: async () => "0xbb",
} as never;

const fakeSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsig",
} as never;

test("saga persists ownerTenantId + specJson and resumes from pending", async () => {
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(`/tmp/legalbody-test-${Math.floor(performance.now())}`);
  const out = await runOnboarding({
    spec,
    idempotencyKey: "t9:tenant-agent",
    repo,
    docStore,
    arc: fakeArc,
    operatorSigner: fakeSigner,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t9",
    specJson: JSON.stringify(spec),
  });
  expect(out.status).toBe("bound");
  expect(out.ownerTenantId).toBe("t9");
  const got = repo.findByIdempotencyKey("t9:tenant-agent");
  expect(got?.ownerTenantId).toBe("t9");
  expect(got?.specJson).toBe(JSON.stringify(spec));
});
