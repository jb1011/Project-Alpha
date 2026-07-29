/**
 * ENSIP-25 on-chain reverse binding (T5). Writes setMetadata(agentId,"ens",<name>) on the
 * ERC-8004 registry so the registry entry points back at the agent's ENS name — the reverse
 * half of the bidirectional binding (the forward half is the name's agent-registration record).
 *
 * Runs standalone with just the MANAGER key (the agent-NFT owner) — no DB, no full backend.
 * Dry-runs (simulate + read-back check) unless SEND=1.
 *
 * Env (put non-secrets in .env; pass the manager key explicitly):
 *   ENS_MANAGER_KEY | PLATFORM_PRIVATE_KEY   manager EOA private key (owns the agent NFTs)
 *   AGENT_ID                                  e.g. 845775
 *   ENS_NAME                                  e.g. <publicId>.novicorpus.eth
 *   ARC_TESTNET_RPC_URL   (default https://rpc.testnet.arc.network)
 *   IDENTITY_REGISTRY     (default 0x8004A818BFB912233c491871b3d84c89A494BD9e)
 *
 *   cd back/backend && AGENT_ID=845775 ENS_NAME=abc.novicorpus.eth \
 *     ENS_MANAGER_KEY=0x... SEND=1 npx tsx scripts/ens-bind-metadata.mts
 */
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  hexToString,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { iIdentityRegistryAbi } from "../src/abis/generated";

const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
const REGISTRY = (process.env.IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;
const KEY = (process.env.ENS_MANAGER_KEY ?? process.env.PLATFORM_PRIVATE_KEY) as Hex | undefined;
const AGENT_ID = process.env.AGENT_ID;
const NAME = process.env.ENS_NAME;

const fail = (m: string): never => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY))
  fail("ENS_MANAGER_KEY (or PLATFORM_PRIVATE_KEY) missing/malformed");
if (!AGENT_ID || !/^\d+$/.test(AGENT_ID)) fail("AGENT_ID missing (expect a decimal agent id)");
if (!NAME) fail("ENS_NAME missing (expect <publicId>.novicorpus.eth)");

const arc = defineChain({
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [RPC] } },
});
const account = privateKeyToAccount(KEY as Hex);
const client = createPublicClient({ chain: arc, transport: http(RPC) });
const wallet = createWalletClient({ chain: arc, transport: http(RPC), account });
const agentId = BigInt(AGENT_ID as string);
const value = toHex(NAME as string); // UTF-8 bytes of the name

async function main() {
  console.log(`\nENSIP-25 reverse binding — agent ${agentId} -> "${NAME}"`);
  console.log(`  registry: ${REGISTRY}`);
  console.log(`  manager:  ${account.address}`);

  const owner = (await client.readContract({
    address: REGISTRY,
    abi: iIdentityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
  })) as Address;
  console.log(`  NFT owner: ${owner}`);
  if (owner.toLowerCase() !== account.address.toLowerCase())
    fail(
      `manager ${account.address} does not own agent ${agentId} (owner ${owner}); cannot setMetadata`,
    );

  const current = (await client.readContract({
    address: REGISTRY,
    abi: iIdentityRegistryAbi,
    functionName: "getMetadata",
    args: [agentId, "ens"],
  })) as Hex;
  console.log(`  current ens metadata: ${current === "0x" ? "(empty)" : hexToString(current)}`);

  const { request } = await client.simulateContract({
    address: REGISTRY,
    abi: iIdentityRegistryAbi,
    functionName: "setMetadata",
    args: [agentId, "ens", value],
    account,
  });
  console.log("  ✓ simulation OK — manager can write.");

  if (process.env.SEND !== "1") {
    console.log("\n(dry run) Re-run with SEND=1 to broadcast.");
    return;
  }

  const hash = await wallet.writeContract(request);
  console.log(`  tx: ${hash}`);
  await client.waitForTransactionReceipt({ hash });

  const after = (await client.readContract({
    address: REGISTRY,
    abi: iIdentityRegistryAbi,
    functionName: "getMetadata",
    args: [agentId, "ens"],
  })) as Hex;
  const decoded = after === "0x" ? "" : hexToString(after);
  console.log(`  read-back ens metadata: "${decoded}"`);
  console.log(
    decoded === NAME
      ? "\n✓ ENSIP-25 reverse binding written and verified on-chain."
      : "\n⚠ read-back does not match written name — investigate.",
  );
}

main().catch((e) => fail(e?.shortMessage ?? e?.message ?? String(e)));
