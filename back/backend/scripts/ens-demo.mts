/**
 * ENS booth demo (T7) — the 5-step agent verification walkthrough.
 *
 * Resolves `<publicId>.novicorpus.eth` LIVE through our CCIP gateway (viem on Sepolia) and
 * cross-checks the ENSIP-25 reverse binding on Arc. This is the judge-facing walkthrough:
 * a stranger, given only a name, verifies the agent's identity, live legal status, and the
 * bidirectional ENS <-> ERC-8004 binding.
 *
 * Requires the gateway to be reachable (deploy first, or pass GATEWAY_URL to point viem at a
 * local/tunnel gateway). Set NAME to a real agent name.
 *   NAME=<publicId>.novicorpus.eth npx tsx --env-file=.env scripts/ens-demo.mts
 *   GATEWAY_URL="https://<tunnel>/ensgateway/{sender}/{data}.json" NAME=... npx tsx ... (local test)
 */
import { http, type Address, type Hex, createPublicClient, defineChain, hexToString } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { iIdentityRegistryAbi } from "../src/abis/generated";

const NAME = process.env.NAME ?? "novicorpus.eth";
const SEPOLIA = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
const REGISTRY = (process.env.IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
// When GATEWAY_URL is set (e.g. a local/tunnel gateway), route viem's CCIP-read fetch there instead
// of the resolver's baked-in URL. viem still runs the real OffchainLookup + on-chain resolveWithProof;
// only the HTTP fetch target changes. Without it, viem uses the resolver's own URL (prod/tunnel).
const LOCAL_GW = process.env.GATEWAY_URL;
const gatewayUrls = undefined;
const eth = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA),
  ...(LOCAL_GW
    ? {
        ccipRead: {
          request: async ({ sender, data }: { sender: Address; data: Hex }) => {
            const u = LOCAL_GW.replace("{sender}", sender.toLowerCase()).replace("{data}", data);
            const j = (await (await fetch(u)).json()) as { data: Hex };
            return j.data;
          },
        },
      }
    : {}),
});
const arc = createPublicClient({
  chain: defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [ARC_RPC] } },
  }),
  transport: http(ARC_RPC),
});

function erc7930(chainId: number, address: Address): string {
  let ref = chainId.toString(16);
  if (ref.length % 2) ref = `0${ref}`;
  const refLen = (ref.length / 2).toString(16).padStart(2, "0");
  return `0x0001${"0000"}${refLen}${ref}14${address.slice(2).toLowerCase()}`;
}

async function main() {
  const name = normalize(NAME);
  console.log(`\n=== Verifying "${name}" via ENS (Sepolia) + Arc ===\n`);

  // 1. name -> the agent's governed treasury address.
  const treasury = await eth.getEnsAddress({ name, gatewayUrls, strict: true });
  console.log(`1. addr (treasury):    ${treasury ?? "(none)"}`);

  // 2. live legal status (reads Arc through the gateway).
  const status = await eth.getEnsText({ name, key: "legal-status", gatewayUrls, strict: true });
  console.log(`2. legal-status:       ${status || "(empty)"}`);

  // 3. metadata URL -> agentId + registry (ENSIP-25 registrations block).
  const url = await eth.getEnsText({ name, key: "url", gatewayUrls, strict: true });
  console.log(`3. metadata url:       ${url || "(empty)"}`);
  // agentId comes from the metadata JSON's registrations block; AGENT_ID env overrides (for local
  // demos where the metadata JSON isn't served for the demo label).
  let agentId: string | undefined = process.env.AGENT_ID;
  if (!agentId && url) {
    try {
      const meta = (await (await fetch(url)).json()) as {
        registrations?: { agentId?: string; agentRegistry?: string }[];
      };
      const reg = meta.registrations?.[0];
      agentId = reg?.agentId;
      console.log(`   -> agentId ${agentId ?? "?"}, registry ${reg?.agentRegistry ?? "?"}`);
    } catch {
      console.log("   -> could not fetch/parse metadata JSON");
    }
  }

  // 4. forward ENSIP-25: the name attests its registry entry.
  let forward = "";
  if (agentId) {
    const key = `agent-registration[${erc7930(CHAIN_ID, REGISTRY)}][${agentId}]`;
    forward = (await eth.getEnsText({ name, key, gatewayUrls, strict: true })) ?? "";
    console.log(`4. ENSIP-25 forward:   ${key} = "${forward}" (expect "1")`);
  }

  // 5. reverse ENSIP-25 on Arc: the registry entry points back at the name.
  let reverse = "";
  if (agentId) {
    const raw = (await arc.readContract({
      address: REGISTRY,
      abi: iIdentityRegistryAbi,
      functionName: "getMetadata",
      args: [BigInt(agentId), "ens"],
    })) as Hex;
    reverse = raw === "0x" ? "" : hexToString(raw);
    console.log(`5. ENSIP-25 reverse:   getMetadata(${agentId},"ens") = "${reverse}"`);
  }

  const verified =
    Boolean(treasury) && forward === "1" && reverse.toLowerCase() === NAME.toLowerCase();
  console.log(
    `\nVERDICT: ${verified ? "✓ VERIFIED — bidirectional ENS <-> ERC-8004 binding holds" : "⚠ not fully verified (see steps above)"}\n`,
  );
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
