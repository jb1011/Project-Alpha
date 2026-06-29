import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TypedDataDefinition } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import type { GuardianPasskey } from "../src/adapters/turnkey/provisioner";
import type { OperatorSigner } from "../src/adapters/turnkey/signer";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { type AgentSpec, parseAgentSpec } from "../src/policy/agentSpec";
import type { EntityRecord } from "../src/types";
import { runOnboarding } from "../src/workflow/onboarding";

// Canonical addresses (distinct from the provisioned operator so distinctness checks pass).
const MANAGER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const GUARDIAN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const PAYOUT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
// The operator the fake provisioner returns (the per-agent Turnkey enclave key).
const PROVISIONED_OPERATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const USDC = "0x3600000000000000000000000000000000000000" as const;

const PASSKEY: GuardianPasskey = {
  authenticatorName: "Guardian Passkey",
  challenge: "test-challenge",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "{}",
    attestationObject: "ao",
    transports: ["internal"],
  },
};

function makeSpec(): AgentSpec {
  return parseAgentSpec({
    name: "Provisioned Agent",
    roles: { manager: MANAGER, guardian: GUARDIAN },
    treasury: {
      payoutAddress: PAYOUT,
      spendingCapUsdc: "1000.00",
      spendingPeriod: "30d",
      allowlistEnabled: false,
    },
    governance: { amendmentDelay: "1h" },
  });
}

/**
 * A deterministic in-memory fake of the slice of ArcAdapter the saga calls. No anvil, no chain — the
 * point of this test is the saga's provision/bind SEAMS, not on-chain behaviour (that's covered by
 * onboarding.int.test.ts). createEntity records the operator it was handed so we can assert the
 * provisioned operator flowed through.
 */
function makeFakeArc() {
  // The saga drives create through the broadcast/confirm seam; broadcast receives the operator, so
  // that's where we assert the provisioned operator flowed through (was createEntity before the split).
  const broadcastCreateEntity = vi.fn(async (_p: { operator: string }) => "0xcreate" as const);
  const confirmCreateEntity = vi.fn(async (txHash: string) => ({
    agentId: 7n,
    proxy: "0x0000000000000000000000000000000000000abc" as const,
    treasury: "0x0000000000000000000000000000000000000def" as const,
    txHash: txHash as `0x${string}`,
  }));
  const setAgentWallet = vi.fn(async () => "0xbind" as const);
  const arc = {
    chainId: 31337,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity,
    confirmCreateEntity,
    setAgentWallet,
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "provision-docs-")));
});

describe("onboarding Step 0: per-agent vault provisioning", () => {
  test("provisions before mint; persists ids + provisioned operator; binds via signerForEntity", async () => {
    const arc = makeFakeArc();
    const provision = vi.fn(async () => ({
      subOrgId: "sub-1",
      walletId: "wal-1",
      operator: PROVISIONED_OPERATOR,
    }));

    // The shared operatorSigner exists but MUST NOT be used on the provisioned path.
    const sharedSign = vi.fn();
    const operatorSigner: OperatorSigner = {
      address: "0xdeadbeef00000000000000000000000000000000",
      signWalletSet: sharedSign as unknown as (td: TypedDataDefinition) => Promise<`0x${string}`>,
    };

    // The per-entity signer the bind step must use instead of operatorSigner.
    const entitySign = vi.fn(async () => "0xsig" as `0x${string}`);
    const signerForEntity = vi.fn(
      async (_e: { subOrgId: string; operator: string }): Promise<OperatorSigner> => ({
        address: PROVISIONED_OPERATOR,
        signWalletSet: entitySign,
      }),
    );

    const rec = await runOnboarding({
      spec: makeSpec(),
      idempotencyKey: "prov-A",
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: USDC,
      guardianPasskey: PASSKEY,
      provision,
      signerForEntity,
    });

    // (1) provision called exactly once, BEFORE createEntity.
    expect(provision).toHaveBeenCalledTimes(1);
    const provisionOrder = provision.mock.invocationCallOrder[0];
    const createOrder = arc.broadcastCreateEntity.mock.invocationCallOrder[0];
    expect(provisionOrder).toBeDefined();
    expect(createOrder).toBeDefined();
    expect(provisionOrder as number).toBeLessThan(createOrder as number);

    // (1b) the provisioned operator flowed into createEntity (not the shared signer address).
    expect(arc.broadcastCreateEntity.mock.calls[0]?.[0].operator).toBe(PROVISIONED_OPERATOR);

    // (2) the persisted record carries the sub-org/wallet ids + the provisioned operator,
    //     and the status has progressed past 'provisioned'.
    const persisted = repo.findByIdempotencyKey("prov-A") as EntityRecord;
    expect(persisted.turnkeySubOrgId).toBe("sub-1");
    expect(persisted.turnkeyWalletId).toBe("wal-1");
    expect(persisted.operator?.toLowerCase()).toBe(PROVISIONED_OPERATOR.toLowerCase());
    expect(["created", "bound", "funded"]).toContain(persisted.status);
    expect(rec.status).toBe("bound");

    // a 'provisioned' audit event was recorded before createEntity.
    const steps = repo.listEvents("prov-A").map((e) => e.step);
    expect(steps[0]).toBe("provisionVault");
    expect(steps).toEqual(["provisionVault", "createEntity", "setAgentWallet"]);

    // (3) the bind step used signerForEntity (NOT the shared operatorSigner).
    expect(signerForEntity).toHaveBeenCalledTimes(1);
    expect(signerForEntity).toHaveBeenCalledWith({
      subOrgId: "sub-1",
      operator: PROVISIONED_OPERATOR,
    });
    expect(entitySign).toHaveBeenCalledTimes(1);
    expect(sharedSign).not.toHaveBeenCalled();
  });

  test("resume: an already-provisioned record does NOT re-provision; reuses stored operator", async () => {
    const arc = makeFakeArc();
    const provision = vi.fn(async () => ({
      subOrgId: "sub-NEW",
      walletId: "wal-NEW",
      operator: "0x000000000000000000000000000000000000bad0" as const,
    }));
    const entitySign = vi.fn(async () => "0xsig" as `0x${string}`);
    const signerForEntity = vi.fn(
      async (): Promise<OperatorSigner> => ({
        address: PROVISIONED_OPERATOR,
        signWalletSet: entitySign,
      }),
    );
    const operatorSigner: OperatorSigner = {
      address: "0xdeadbeef00000000000000000000000000000000",
      signWalletSet: vi.fn() as unknown as (td: TypedDataDefinition) => Promise<`0x${string}`>,
    };

    // Seed a record already provisioned (Step 0 done) but not yet created.
    repo.upsert({
      idempotencyKey: "prov-B",
      name: "Provisioned Agent",
      status: "provisioned",
      manager: MANAGER,
      guardian: GUARDIAN,
      operator: PROVISIONED_OPERATOR,
      amendmentDelay: "3600",
      ein: "STUB-NOT-FILED",
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
      turnkeySubOrgId: "sub-1",
      turnkeyWalletId: "wal-1",
    });

    const rec = await runOnboarding({
      spec: makeSpec(),
      idempotencyKey: "prov-B",
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: USDC,
      guardianPasskey: PASSKEY,
      provision,
      signerForEntity,
    });

    // (4) provision was NOT called again on resume.
    expect(provision).not.toHaveBeenCalled();
    // the stored sub-org/operator are reused (no second sub-org), and flow into createEntity + bind.
    expect(rec.turnkeySubOrgId).toBe("sub-1");
    expect(rec.operator?.toLowerCase()).toBe(PROVISIONED_OPERATOR.toLowerCase());
    expect(arc.broadcastCreateEntity.mock.calls[0]?.[0].operator).toBe(PROVISIONED_OPERATOR);
    expect(signerForEntity).toHaveBeenCalledWith({
      subOrgId: "sub-1",
      operator: PROVISIONED_OPERATOR,
    });
    expect(rec.status).toBe("bound");
  });
});
