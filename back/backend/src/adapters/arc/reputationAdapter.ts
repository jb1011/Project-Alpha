import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { reputationRegistryAbi } from "../../abis/generated";

export interface ReputationAdapterDeps {
  publicClient: PublicClient;
  recorderWallet: WalletClient;
  registry: Address;
}

export class ReputationAdapter {
  constructor(private readonly d: ReputationAdapterDeps) {}

  /**
   * Record feedback about an agent. Signed by the recorder (evaluator/client) — never the agent
   * itself (the registry blocks self-feedback). Maps a simple score to the on-chain 8-arg
   * giveFeedback.
   */
  async record(p: {
    agentId: bigint;
    value: number;
    feedbackHash: Hex;
    feedbackURI?: string;
    tag1?: string;
  }): Promise<Hex> {
    if (!this.d.recorderWallet.account)
      throw new Error("record: recorderWallet.account is required");
    const { request } = await this.d.publicClient.simulateContract({
      address: this.d.registry,
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [
        p.agentId,
        BigInt(p.value),
        0,
        p.tag1 ?? "job",
        "",
        "",
        p.feedbackURI ?? "",
        p.feedbackHash,
      ],
      account: this.d.recorderWallet.account,
    });
    const h = await this.d.recorderWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash: h });
    return h;
  }
}
