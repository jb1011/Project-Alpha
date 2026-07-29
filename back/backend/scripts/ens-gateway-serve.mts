/**
 * Minimal standalone ENS CCIP gateway server (demo prep). Mounts the REAL ensGateway route
 * with a real read-only Arc adapter and one demo entity, WITHOUT booting the full backend.
 * Lets us exercise the complete live HTTP resolution path (viem -> OffchainLookup -> HTTP ->
 * this gateway -> resolveWithProof) locally, and expose it via a tunnel for external wallets.
 *
 *   cd back/backend && npx tsx --env-file=.env scripts/ens-gateway-serve.mts
 *   (serves on :8788; override with PORT)
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { mountEnsGatewayRoutes } from "../src/api/routes/ensGateway";

const PORT = Number(process.env.PORT ?? 8788);
// drpc.org tested more reliable than the public node for the gateway's read load.
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://arc-testnet.drpc.org";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const REGISTRY = (process.env.IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;
const FACTORY = "0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902" as Address;
const SIGNER_KEY = process.env.ENS_GATEWAY_SIGNER_KEY as Hex;
const PARENT = process.env.ENS_PARENT_NAME ?? "novicorpus.eth";
const META_BASE = process.env.METADATA_BASE_URL ?? "https://project-alpha-pi.vercel.app/backend";
if (!SIGNER_KEY) throw new Error("ENS_GATEWAY_SIGNER_KEY not set in .env");

const arcChain = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});
const publicClient = createPublicClient({
  chain: arcChain,
  transport: http(ARC_RPC, { batch: false, retryCount: 5, retryDelay: 300 }),
});
// managerWallet is required by ArcAdapter but only used for writes; the gateway calls read-only
// methods (legalStatus/treasuryPaused/getAgentMetadata), so a dummy account is fine here.
const managerWallet = createWalletClient({
  chain: arcChain,
  transport: http(ARC_RPC),
  account: privateKeyToAccount(`0x${"1".repeat(64)}`),
});
const arc = new ArcAdapter({
  publicClient,
  managerWallet,
  chainId: CHAIN_ID,
  factory: FACTORY,
  identityRegistry: REGISTRY,
});

// One demo entity = real agent 845859 (owner 0xb43C…). Label "demo" -> demo.novicorpus.eth.
const demo = {
  name: "Demo Agent (845859)",
  treasury: "0x4c2E9Bf4314c0D5555c08e15F24c7f1D2f15c540" as Address,
  operator: "0x6652749364b424612a33C9a67cb7acD1bFc3E51A" as Address,
  proxy: "0x7d03088A73816788bB1a274b6666629aB0E62D1C" as Address,
  agentId: "845859",
  publicId: "demo",
};

const deps = {
  ens: {
    signer: privateKeyToAccount(SIGNER_KEY),
    parentName: PARENT,
    metadataBaseUrl: META_BASE,
    identityRegistry: REGISTRY,
    chainId: CHAIN_ID,
  },
  repo: { findByPublicId: (id: string) => (id === "demo" ? demo : undefined) },
  arc,
  platformManagerAddress: "0xb43CbdA374e3CD2a3d67827683F81462BaCF703b",
  mcpPublicUrl: `${META_BASE}/mcp`,
  webOrigin: "https://project-alpha-pi.vercel.app",
  // biome-ignore lint/suspicious/noExplicitAny: partial ApiDeps for the standalone gateway.
} as any;

const app = new Hono();
app.use("*", cors({ origin: "*" }));
app.get("/", (c) => c.text("Novi Corpus ENS gateway (demo). Try /ensgateway/:sender/:data.json"));
// biome-ignore lint/suspicious/noExplicitAny: app variable typing for the shared mount fn.
mountEnsGatewayRoutes(app as any, deps);

serve({ fetch: app.fetch, port: PORT });
console.log(`ENS gateway serving on http://localhost:${PORT}`);
console.log(`  demo name: demo.${PARENT} -> agent ${demo.agentId} (treasury ${demo.treasury})`);
console.log(`  gatewayUrls: http://localhost:${PORT}/ensgateway/{sender}/{data}.json`);
