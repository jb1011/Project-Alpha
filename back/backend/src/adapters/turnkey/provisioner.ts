import { getAddress } from "viem";

const ETH_ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM",
} as const;

export interface GuardianPasskey {
  authenticatorName?: string;
  challenge: string;
  attestation: {
    credentialId: string;
    clientDataJson: string;
    attestationObject: string;
    transports: string[];
  };
}

export interface ProvisionParams {
  subOrgName: string;
  guardianPasskey: GuardianPasskey;
  guardianEmail?: string;
  delegatedApiPublicKey: string;
}

export interface VaultIds {
  subOrgId: string;
  walletId: string;
  operator: `0x${string}`;
  guardianUserId: string;
  delegatedUserId: string;
}

// The minimal Turnkey apiClient surface we call (the real @turnkey/sdk-server client satisfies it).
// biome-ignore lint/suspicious/noExplicitAny: Turnkey's apiClient boundary is loosely typed
export type TurnkeyApiClient = any;

export interface ProvisionDeps {
  parentClient: TurnkeyApiClient; // parent-org API key — creates sub-orgs
  makeDelegatedClient: (subOrgId: string) => TurnkeyApiClient; // delegated API key scoped to the sub-org
}

/**
 * Create a per-agent vault: guardian-root (passkey) + a sign-only delegated backend key. Non-custodial.
 *
 * NOTE: the `createSubOrganization` result carries the wallet under `sub.wallet.walletId` /
 * `sub.wallet.addresses`. If the installed @turnkey/sdk-server version returns it under a different
 * field (e.g. `sub.wallets[0]`), update the access path here and call `parentClient.getWallets` /
 * `getWalletAccounts` if needed. The deterministic test fakes this shape so tsc won't catch drift.
 */
export async function provisionAgentVault(
  deps: ProvisionDeps,
  p: ProvisionParams,
): Promise<VaultIds> {
  // STEP 1 — sub-org with the delegated user (api key) + the guardian (passkey) as root users.
  const sub = await deps.parentClient.createSubOrganization({
    subOrganizationName: p.subOrgName,
    rootUsers: [
      {
        userName: "Delegated Access User",
        apiKeys: [
          {
            apiKeyName: "Backend Delegated Key",
            publicKey: p.delegatedApiPublicKey,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
      {
        userName: "Guardian",
        userEmail: p.guardianEmail,
        apiKeys: [],
        authenticators: [
          {
            authenticatorName: p.guardianPasskey.authenticatorName ?? "Guardian Passkey",
            challenge: p.guardianPasskey.challenge,
            attestation: p.guardianPasskey.attestation,
          },
        ],
        oauthProviders: [],
      },
    ],
    rootQuorumThreshold: 1,
    wallet: { walletName: "Agent vault", accounts: [ETH_ACCOUNT] },
  });

  if (!Array.isArray(sub.rootUserIds) || sub.rootUserIds.length < 2) {
    throw new Error("Turnkey createSubOrganization did not return the two expected root user ids");
  }

  const subOrgId: string = sub.subOrganizationId;
  const delegatedUserId: string = sub.rootUserIds[0];
  const guardianUserId: string = sub.rootUserIds[1];
  const walletId: string = sub.wallet.walletId;
  const rawAddress: string | undefined = sub.wallet.addresses[0];
  if (!rawAddress) {
    throw new Error(`provisionAgentVault: no Ethereum address returned for wallet ${walletId}`);
  }
  const operator = getAddress(rawAddress);

  // STEP 2 — scope the delegated user to sign-only this agent's wallet (run as the delegated user).
  const delegated = deps.makeDelegatedClient(subOrgId);
  await delegated.createPolicy({
    policyName: "Backend delegated: sign-only this agent's wallet",
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${delegatedUserId}')`,
    condition: `activity.action == 'SIGN' && wallet.id == '${walletId}'`,
    notes: "",
  });

  // STEP 3 — remove the delegated user from root; the guardian is the sole root (non-custodial).
  await delegated.updateRootQuorum({ threshold: 1, userIds: [guardianUserId] });

  return { subOrgId, walletId, operator, guardianUserId, delegatedUserId };
}
