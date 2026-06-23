import { Turnkey } from "@turnkey/sdk-server";
import type { Config } from "../../config/env";

export interface ProvisionDeps {
  parentClient: ReturnType<InstanceType<typeof Turnkey>["apiClient"]>;
  makeDelegatedClient: (subOrgId: string) => ReturnType<InstanceType<typeof Turnkey>["apiClient"]>;
}

/**
 * Build the two Turnkey API clients needed for per-agent vault provisioning:
 * - `parentClient`: authenticated as the root org (apiPublicKey/apiPrivateKey + organizationId).
 * - `makeDelegatedClient(subOrgId)`: authenticated with the DELEGATED keypair, scoped to the
 *   agent's sub-org (defaultOrganizationId = subOrgId).  Used by the provisioner (Task 3) and by
 *   TurnkeySigner.forEntity / buildOperatorWalletClientForEntity (Task 4).
 */
export function buildTurnkeyProvisionDeps(cfg: Config): ProvisionDeps {
  const tk = cfg.turnkey;
  if (!tk) {
    throw new Error("buildTurnkeyProvisionDeps: Turnkey config is missing from Config.");
  }
  if (!tk.delegatedApiPublicKey || !tk.delegatedApiPrivateKey) {
    throw new Error(
      "buildTurnkeyProvisionDeps: TURNKEY_DELEGATED_API_PUBLIC_KEY and TURNKEY_DELEGATED_API_PRIVATE_KEY must be set.",
    );
  }

  const parentClient = new Turnkey({
    apiBaseUrl: tk.baseUrl,
    apiPublicKey: tk.apiPublicKey,
    apiPrivateKey: tk.apiPrivateKey,
    defaultOrganizationId: tk.organizationId,
  }).apiClient();

  function makeDelegatedClient(subOrgId: string) {
    return new Turnkey({
      apiBaseUrl: tk!.baseUrl,
      apiPublicKey: tk!.delegatedApiPublicKey!,
      apiPrivateKey: tk!.delegatedApiPrivateKey!,
      defaultOrganizationId: subOrgId,
    }).apiClient();
  }

  return { parentClient, makeDelegatedClient };
}
