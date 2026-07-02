import type { PublicClient, WriteContractReturnType } from "viem";
import { arcTestnet } from "@/lib/chain";
import { treasuryAbi } from "@/lib/treasuryAbi";

type WriteFn = (args: {
  address: `0x${string}`;
  abi: typeof treasuryAbi;
  functionName: "setAllowlistEntry";
  args: [`0x${string}`, boolean];
  chainId: number;
}) => Promise<WriteContractReturnType>;

/** Guardian-signed: allow each address on the treasury allowlist (one tx per entry). */
export async function wireAllowlistEntries(opts: {
  treasury: `0x${string}`;
  addresses: string[];
  writeContractAsync: WriteFn;
  publicClient: PublicClient;
}): Promise<void> {
  for (const raw of opts.addresses) {
    const account = raw.trim() as `0x${string}`;
    if (!account) continue;
    const hash = await opts.writeContractAsync({
      address: opts.treasury,
      abi: treasuryAbi,
      functionName: "setAllowlistEntry",
      args: [account, true],
      chainId: arcTestnet.id,
    });
    await opts.publicClient.waitForTransactionReceipt({ hash });
  }
}
