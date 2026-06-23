// backend/src/adapters/x402/gateway.ts
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "../../types";

export interface PocketGatewayOpts {
  pocketPrivateKey: Hex;
  rpcUrl: string;
}

/** The pocket's Gateway balance: deposit USDC the pocket holds, read its available balance. */
export class PocketGateway {
  private readonly client: GatewayClient;
  readonly address: Address;
  constructor(opts: PocketGatewayOpts) {
    this.client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: opts.pocketPrivateKey,
      rpcUrl: opts.rpcUrl,
    });
    this.address = privateKeyToAccount(opts.pocketPrivateKey).address;
  }
  /** Deposit `amountUsdc` (decimal string, e.g. "0.5") from the pocket EOA into its Gateway balance. */
  deposit(amountUsdc: string) {
    return this.client.deposit(amountUsdc);
  }
  async getAvailable(): Promise<number> {
    const b = await this.client.getBalances();
    return Number(b.gateway.formattedAvailable);
  }
}
