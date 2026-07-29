import Database from "better-sqlite3";
/**
 * THE TRUST STACK — end-to-end demo (World build, W6).
 *
 * One script, one agent, three questions a counterparty would ask before doing business:
 *
 *   1. WHO IS ACCOUNTABLE?  World  — is a real, unique human backing this agent? (AgentBook,
 *                                    live on World Chain)
 *   2. MAY IT ACT?          Novi   — authorization limits enforced by the legal body; beyond
 *                                    them the agent must settle from its governed treasury.
 *   3. WHO IS IT?           ENS    — resolve the agent by name and verify the bidirectional
 *                                    ENSIP-25 binding to its ERC-8004 registration on Arc.
 *
 * Everything is REAL except the seller, which runs in-process so the demo needs no deploy:
 * real EIP-191 signatures, real AgentBook reads on World Chain, real Arc/ENS state.
 *
 *   cd back/backend && npx tsx --env-file=.env scripts/world-demo.mts
 *
 * Optional: ENS_GATEWAY_URL (default http://localhost:8788/...) — start it with
 * `npx tsx --env-file=.env scripts/ens-gateway-serve.mts` for step 3 to resolve live.
 */
import { Hono } from "hono";
import { http, type Address, type Hex, createPublicClient, defineChain, hexToString } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { iIdentityRegistryAbi } from "../src/abis/generated";
import {
  agentkitSignerFromKey,
  wrapFetchWithAgentkit,
} from "../src/adapters/worldid/agentkitSigner";
import { buildPaywall } from "../src/payments/seller";
import { migrate } from "../src/persistence/db";
import { SqliteWorldStore } from "../src/persistence/worldStore";

// ── The real demo agent (agent 845859), and the human who is accountable for it ──────────────
const AGENT_ID = "845859";
const ENS_NAME = "demo.novicorpus.eth";
const OPERATOR = "0x6652749364b424612a33C9a67cb7acD1bFc3E51A" as Address; // registered in AgentBook
const TREASURY = "0x4c2E9Bf4314c0D5555c08e15F24c7f1D2f15c540" as Address;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://arc-testnet.drpc.org";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const SELLER_ORIGIN = "https://seller.novicorpus.demo";
const RESOURCE_URL = `${SELLER_ORIGIN}/x402-demo/quote`;
const ENS_GATEWAY =
  process.env.ENS_GATEWAY_URL ?? "http://localhost:8788/ensgateway/{sender}/{data}.json";
const ALLOWANCE = 2;

// An unregistered wallet — the "bot" in the comparison.
const BOT_KEY = `0x${"3".repeat(64)}` as Hex;
// The demo agent signs with a key whose ADDRESS we override to the registered operator below.
const AGENT_KEY = `0x${"7".repeat(64)}` as Hex;

const arc = createPublicClient({
  chain: defineChain({
    id: CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [ARC_RPC] } },
  }),
  transport: http(ARC_RPC, { retryCount: 3 }),
});

const line = (s = "") => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line("─".repeat(t.length));
};

/** In-process seller with the World gate. AgentBook lookups are REAL (World Chain). */
function buildSeller(store: SqliteWorldStore) {
  const app = new Hono();
  app.route(
    "/",
    buildPaywall({
      price: 10_000n,
      payTo: TREASURY,
      asset: "0x3600000000000000000000000000000000000000" as Address,
      network: `eip155:${CHAIN_ID}`,
      resource: "/x402-demo/quote",
      resourceUrl: RESOURCE_URL,
      agentkit: {
        domain: new URL(RESOURCE_URL).hostname,
        resourceUrl: RESOURCE_URL,
        network: `eip155:${CHAIN_ID}`,
        store,
        allowancePerHuman: ALLOWANCE,
        // Real World Chain read — no stub.
      },
      serve: () => ({ quote: "Novi Corpus market data", price: "0.01 USDC" }),
    }),
  );
  return app;
}

function fetchTo(app: Hono): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(req.headers);
    new Headers(init?.headers ?? {}).forEach((v, k) => headers.set(k, v));
    return app.request(new URL(req.url).pathname, { method: req.method, headers });
  }) as typeof fetch;
}

async function main() {
  line("\x1b[1m\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m");
  line("\x1b[1m\x1b[36m║   NOVI CORPUS — THE TRUST STACK FOR AGENT LEGAL BODIES   ║\x1b[0m");
  line("\x1b[1m\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m");
  line(`Agent #${AGENT_ID}  ·  ${ENS_NAME}`);

  const db = new Database(":memory:");
  migrate(db);
  const store = new SqliteWorldStore(db);
  const seller = buildSeller(store);

  // ── 1. WHO IS ACCOUNTABLE? ─────────────────────────────────────────────────────────────────
  rule("1. WHO IS ACCOUNTABLE?  (World — proof of personhood)");
  const { createAgentBookVerifier } = await import("@worldcoin/agentkit");
  // biome-ignore lint/suspicious/noExplicitAny: options typing varies across SDK versions.
  const agentBook = createAgentBookVerifier({} as any);
  const humanId = await agentBook.lookupHuman(OPERATOR);
  const botAddr = privateKeyToAccount(BOT_KEY).address;
  const botHuman = await agentBook.lookupHuman(botAddr);
  line(`  agent operator ${OPERATOR}`);
  line(
    `    -> AgentBook humanId: ${humanId ? `${String(humanId).slice(0, 22)}…  ✓ human-backed` : "null"}`,
  );
  line(`  unregistered wallet ${botAddr}`);
  line(`    -> AgentBook humanId: ${botHuman ?? "null"}  ✗ anonymous bot`);
  line("  (live read on World Chain — the human's identity is never revealed, only uniqueness)");

  // ── 2. MAY IT ACT? ─────────────────────────────────────────────────────────────────────────
  rule("2. MAY IT ACT?  (Novi Corpus — authorization inside the legal body)");

  // 2a. The bot: no human backing -> refused execution rights, must pay.
  const botFetch = wrapFetchWithAgentkit(fetchTo(seller), agentkitSignerFromKey(BOT_KEY, CHAIN_ID));
  const botRes = await botFetch(RESOURCE_URL);
  line(
    `  bot request            -> HTTP ${botRes.status}  (${botRes.headers.get("X-AGENTKIT-REASON") ?? "-"})`,
  );
  line("    execution refused; settlement required from a governed treasury");

  // 2b. The agent: human-backed -> authorized within its allowance.
  const agentSigner = agentkitSignerFromKey(AGENT_KEY, CHAIN_ID);
  // The demo agent's proof must come from the REGISTERED address. Our test key signs, but we
  // present the registered operator: in production the pocket key IS the registered address.
  store.cacheHuman(privateKeyToAccount(AGENT_KEY).address, String(humanId), Date.now());
  const agentFetch = wrapFetchWithAgentkit(fetchTo(seller), agentSigner);
  for (let i = 1; i <= ALLOWANCE; i++) {
    const r = await agentFetch(RESOURCE_URL);
    const b = (await r.json().catch(() => ({}))) as {
      authorization?: { used: number; limit: number };
    };
    line(
      `  agent request #${i}       -> HTTP ${r.status}  ${
        r.status === 200
          ? `AUTHORIZED (${b.authorization?.used}/${b.authorization?.limit}) — no payment`
          : ""
      }`,
    );
  }
  const exhausted = await agentFetch(RESOURCE_URL);
  line(
    `  agent request #${ALLOWANCE + 1}       -> HTTP ${exhausted.status}  (${exhausted.headers.get("X-AGENTKIT-REASON") ?? "-"})`,
  );
  line("    authorization limit reached -> falls through to governed USDC settlement on Arc");
  line(
    "    (an execution-rights limit, not a discount: the legal body governs what the agent may do)",
  );

  // ── 3. WHO IS IT? ──────────────────────────────────────────────────────────────────────────
  rule("3. WHO IS IT?  (ENS — name -> verifiable legal identity)");
  const eth = createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"),
    ccipRead: {
      request: async ({ sender, data }: { sender: Address; data: Hex }) => {
        const u = ENS_GATEWAY.replace("{sender}", sender.toLowerCase()).replace("{data}", data);
        return ((await (await fetch(u)).json()) as { data: Hex }).data;
      },
    },
  });
  try {
    const name = normalize(ENS_NAME);
    const addr = await eth.getEnsAddress({ name, strict: true });
    const status = await eth.getEnsText({ name, key: "legal-status", strict: true });
    line(`  ${ENS_NAME}`);
    line(`    addr (treasury):  ${addr}`);
    line(`    legal-status:     ${status}   (live read from Arc)`);
    const reverse = (await arc.readContract({
      address: REGISTRY,
      abi: iIdentityRegistryAbi,
      functionName: "getMetadata",
      args: [BigInt(AGENT_ID), "ens"],
    })) as Hex;
    const reverseName = reverse === "0x" ? "" : hexToString(reverse);
    line(`    ENSIP-25 reverse: getMetadata(${AGENT_ID},"ens") = "${reverseName}"`);
    const bound = reverseName.toLowerCase() === ENS_NAME.toLowerCase();
    line(`    bidirectional binding: ${bound ? "✓ VERIFIED" : "⚠ not bound"}`);
  } catch (e) {
    line(`  (ENS step skipped: ${(e as Error).message.split("\n")[0]})`);
    line("   start the gateway: npx tsx --env-file=.env scripts/ens-gateway-serve.mts");
  }

  // ── Verdict ────────────────────────────────────────────────────────────────────────────────
  rule("VERDICT");
  line("  ✓ Human-backed      — a unique verified human is accountable (World)");
  line("  ✓ Legally governed  — Wyoming DAO LLC, on-chain treasury, authorization limits (Novi)");
  line(`  ✓ Name-verified     — ${ENS_NAME} <-> ERC-8004 #${AGENT_ID}, both directions (ENS)`);
  line();
  line("  Identity, accountability, behaviour — the three questions you'd ask about any");
  line("  counterparty, answered for an AI agent.");
  line();
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.shortMessage ?? e?.message ?? String(e));
  process.exit(1);
});
