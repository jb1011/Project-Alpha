import type { Address, Hex, TypedDataDefinition } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/**
 * The agent's operator key (the bound agentWallet). It must produce the EIP-712 AgentWalletSet
 * signature for setAgentWallet. It does NOT send transactions (no gas) — the manager does that.
 * v1 demo: LocalKeySigner. Production: TurnkeySigner (Task 4.3), same interface.
 */
export interface OperatorSigner {
  readonly address: Address;
  signWalletSet(typedData: TypedDataDefinition): Promise<Hex>;
}

export class LocalKeySigner implements OperatorSigner {
  private readonly account: PrivateKeyAccount;
  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }
  get address(): Address {
    return this.account.address;
  }
  signWalletSet(typedData: TypedDataDefinition): Promise<Hex> {
    return this.account.signTypedData(typedData);
  }
}
