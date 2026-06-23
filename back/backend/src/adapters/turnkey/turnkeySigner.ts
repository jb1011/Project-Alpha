import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import type { Address, Hex, TypedDataDefinition } from "viem";
import type { Config } from "../../config/env";
import type { OperatorSigner } from "./signer";

export interface TurnkeyConfig {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
  baseUrl: string;
}

type TurnkeyAccount = Awaited<ReturnType<typeof createAccount>>;

/**
 * Operator signer backed by a Turnkey enclave key (non-custodial "infrastructure-mediated
 * self-custody"). Wraps a Turnkey-signed viem account. The key never leaves the TEE; we only obtain
 * EIP-712 signatures for setAgentWallet — this signer NEVER sends transactions (the manager does).
 * Provisioning (per-agent sub-org with the human registrant as ROOT + delegated access) is performed
 * out of band in v1; here we sign with an already-provisioned key (`signWith` = key id or address).
 */
export class TurnkeySigner implements OperatorSigner {
  readonly address: Address;
  private readonly account: TurnkeyAccount;

  private constructor(account: TurnkeyAccount) {
    this.address = account.address;
    this.account = account;
  }

  /** Build a signer for an existing Turnkey wallet/key (signWith = key id or address). */
  static async forKey(cfg: TurnkeyConfig, signWith: string): Promise<TurnkeySigner> {
    const turnkey = new Turnkey({
      apiBaseUrl: cfg.baseUrl,
      apiPublicKey: cfg.apiPublicKey,
      apiPrivateKey: cfg.apiPrivateKey,
      defaultOrganizationId: cfg.organizationId,
    });
    const account = await createAccount({
      client: turnkey.apiClient(),
      organizationId: cfg.organizationId,
      signWith,
    });
    return new TurnkeySigner(account);
  }

  /**
   * Build a signer for a per-agent sub-org using the DELEGATED Turnkey keypair.
   * The delegated client is scoped to `subOrgId`; `signWith` is the operator address/key id
   * provisioned inside that sub-org.  Throws if the delegated keypair is not configured.
   */
  static async forEntity(
    cfg: Config,
    e: { subOrgId: string; operator: string },
  ): Promise<TurnkeySigner> {
    const tk = cfg.turnkey;
    if (!tk) {
      throw new Error("TurnkeySigner.forEntity: Turnkey config is missing from Config.");
    }
    if (!tk.delegatedApiPublicKey || !tk.delegatedApiPrivateKey) {
      throw new Error(
        "TurnkeySigner.forEntity: TURNKEY_DELEGATED_API_PUBLIC_KEY and TURNKEY_DELEGATED_API_PRIVATE_KEY must be set.",
      );
    }
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
    return new TurnkeySigner(account);
  }

  signWalletSet(typedData: TypedDataDefinition): Promise<Hex> {
    return this.account.signTypedData(typedData);
  }
}
