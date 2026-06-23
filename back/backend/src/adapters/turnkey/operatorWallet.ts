import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { http, type WalletClient, createWalletClient, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../../config/env";

function arcChain(cfg: Config) {
  return defineChain({
    id: cfg.chainId,
    name: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

/**
 * Build a WalletClient that SENDS transactions as the operator (the enclave). Production: a Turnkey
 * account (key stays in the enclave; @turnkey/viem returns a LocalAccount that can sign transactions).
 * Fallback: a local key from OPERATOR_PRIVATE_KEY (testnet/dev only).
 */
export async function buildOperatorWalletClient(cfg: Config): Promise<WalletClient> {
  const transport = http(cfg.rpcUrl);
  const chain = arcChain(cfg);
  if (cfg.turnkey) {
    const turnkey = new Turnkey({
      apiBaseUrl: cfg.turnkey.baseUrl,
      apiPublicKey: cfg.turnkey.apiPublicKey,
      apiPrivateKey: cfg.turnkey.apiPrivateKey,
      defaultOrganizationId: cfg.turnkey.organizationId,
    });
    const account = await createAccount({
      client: turnkey.apiClient(),
      organizationId: cfg.turnkey.organizationId,
      signWith: cfg.turnkey.signWith,
    });
    return createWalletClient({ account, chain, transport });
  }
  if (cfg.operatorPrivateKey) {
    return createWalletClient({
      account: privateKeyToAccount(cfg.operatorPrivateKey),
      chain,
      transport,
    });
  }
  throw new Error(
    "No operator wallet configured: set TURNKEY_* (preferred) or OPERATOR_PRIVATE_KEY.",
  );
}

/**
 * Build a WalletClient for a specific agent entity, using the DELEGATED Turnkey keypair scoped to
 * that agent's sub-org.  Mirrors `buildOperatorWalletClient`'s Turnkey branch but:
 *   - uses `delegatedApiPublicKey` / `delegatedApiPrivateKey` instead of the root keypair
 *   - sets both `defaultOrganizationId` and `createAccount`'s `organizationId` to `subOrgId`
 *   - uses `operator` as `signWith`
 * Throws if the delegated keypair is absent.
 */
export async function buildOperatorWalletClientForEntity(
  cfg: Config,
  e: { subOrgId: string; operator: string },
): Promise<WalletClient> {
  const tk = cfg.turnkey;
  if (!tk) {
    throw new Error("buildOperatorWalletClientForEntity: Turnkey config is missing from Config.");
  }
  if (!tk.delegatedApiPublicKey || !tk.delegatedApiPrivateKey) {
    throw new Error(
      "buildOperatorWalletClientForEntity: TURNKEY_DELEGATED_API_PUBLIC_KEY and TURNKEY_DELEGATED_API_PRIVATE_KEY must be set.",
    );
  }
  const transport = http(cfg.rpcUrl);
  const chain = arcChain(cfg);
  const turnkey = new Turnkey({
    apiBaseUrl: tk.baseUrl,
    apiPublicKey: tk.delegatedApiPublicKey,
    apiPrivateKey: tk.delegatedApiPrivateKey,
    defaultOrganizationId: e.subOrgId,
  });
  const account = await createAccount({
    client: turnkey.apiClient(),
    organizationId: e.subOrgId,
    signWith: e.operator,
  });
  return createWalletClient({ account, chain, transport });
}
