import { expect, test, vi } from "vitest";
import { provisionAgentVault } from "../../../src/adapters/turnkey/provisioner";

const passkey = {
  challenge: "chal",
  attestation: {
    credentialId: "cid",
    clientDataJson: "cdj",
    attestationObject: "att",
    transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"],
  },
};

test("provisions: createSubOrg(2 root users) -> createPolicy(sign-only) -> updateRootQuorum(guardian only)", async () => {
  const createSubOrganization = vi.fn(async () => ({
    subOrganizationId: "suborg-1",
    rootUserIds: ["delegated-uid", "guardian-uid"],
    wallet: { walletId: "wallet-1", addresses: ["0x00000000000000000000000000000000000000ab"] },
  }));
  const createPolicy = vi.fn(async () => ({ policyId: "pol-1" }));
  const updateRootQuorum = vi.fn(async () => ({}));
  const delegatedClient = { createSubOrganization: vi.fn(), createPolicy, updateRootQuorum };
  const deps = {
    parentClient: {
      createSubOrganization,
      createPolicy: vi.fn(),
      updateRootQuorum: vi.fn(),
    } as never,
    makeDelegatedClient: vi.fn(() => delegatedClient as never),
  };

  const ids = await provisionAgentVault(deps, {
    subOrgName: "projectAlpha - agent vault",
    guardianPasskey: passkey,
    delegatedApiPublicKey: "dpub",
  });

  // 1) sub-org with delegated (apiKey) + guardian (passkey) root users
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock inspection
  const subArgs = (createSubOrganization.mock.calls as any[][])[0]![0];
  expect(subArgs.rootUsers).toHaveLength(2);
  expect(subArgs.rootUsers[0].apiKeys[0].publicKey).toBe("dpub");
  expect(subArgs.rootUsers[1].authenticators[0].attestation.credentialId).toBe("cid");
  expect(subArgs.rootQuorumThreshold).toBe(1);

  // 2) policy: delegated user, sign-only that wallet (run via the delegated client)
  expect(deps.makeDelegatedClient).toHaveBeenCalledWith("suborg-1");
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock inspection
  const polArgs = (createPolicy.mock.calls as any[][])[0]![0];
  expect(polArgs.consensus).toContain("delegated-uid");
  expect(polArgs.condition).toContain("activity.action == 'SIGN'");
  expect(polArgs.condition).toContain("wallet.id == 'wallet-1'");

  // 2b) ordering: policy must be created before the quorum is narrowed (once delegated user is
  //     removed from root in step 3, it can no longer be authorised to create policies)
  expect(createPolicy.mock.invocationCallOrder[0]!).toBeLessThan(
    updateRootQuorum.mock.invocationCallOrder[0]!,
  );

  // 3) root quorum reduced to the guardian only
  expect(updateRootQuorum).toHaveBeenCalledWith({ threshold: 1, userIds: ["guardian-uid"] });

  expect(ids).toEqual({
    subOrgId: "suborg-1",
    walletId: "wallet-1",
    operator: "0x00000000000000000000000000000000000000AB",
    guardianUserId: "guardian-uid",
    delegatedUserId: "delegated-uid",
  });
});
