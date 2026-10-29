/**
 * `pilot:job --yes` on anvil through the command's own wiring: the chain from `buildPilotChain`,
 * the lookup from `httpLookupClient` (its two requests answered by a stubbed fetch; every other
 * request, the node's included, goes to the real one), the real pre-flight and `createPilotJob`,
 * over a context built from the anvil clients and a SQLite file in a temp directory. Only the
 * config is given, since the default reads the process environment.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  http,
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  getAddress,
  keccak256,
} from "viem";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { mockErc8183JobAbi, mockIdentityRegistryAbi } from "../../src/abis/generated";
import { anvilChain } from "../../src/chains";
import { registerPilotCommands } from "../../src/cli/pilot";
import type { Config } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import type { PilotContext } from "../../src/pilot/context";
import { type MockJobEnv, deployMockJob } from "../helpers/anvilJob";
import { loadArtifact } from "../helpers/artifacts";

const LOOKUP_BASE = "https://lookup.example.com";
const DELIVERABLE = "date,amount\n2026-10-01,12.50\n";

let env: MockJobEnv;
let registry: Address;
const agentIds = { buyer: "", seller: "" };

async function deployRegistry(wallet: WalletClient, pub: PublicClient): Promise<Address> {
  const { abi, bytecode } = loadArtifact("MockIdentityRegistry");
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [],
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockIdentityRegistry deploy produced no address");
  return getAddress(receipt.contractAddress);
}

async function register(wallet: WalletClient): Promise<string> {
  const { request, result } = await env.publicClient.simulateContract({
    address: registry,
    abi: mockIdentityRegistryAbi,
    functionName: "register",
    args: [""],
    account: wallet.account!,
  });
  const hash = await wallet.writeContract(request);
  await env.publicClient.waitForTransactionReceipt({ hash });
  return result.toString();
}

beforeAll(async () => {
  env = await deployMockJob();
  registry = await deployRegistry(env.clientWallet, env.publicClient);
  agentIds.buyer = await register(env.clientWallet);
  agentIds.seller = await register(env.providerWallet);
  // The default budget is 2.00 USDC, and the pre-flight wants 0.5 USDC on top.
  await env.mintUsdc(env.clientAddr, 5_000_000n);
});

afterAll(() => env?.stop());
afterEach(() => vi.unstubAllGlobals());

/** The two lookups answer an active legal body; anything else reaches the real fetch. */
function stubLookups(): string[] {
  const realFetch = globalThis.fetch;
  const looked: string[] = [];
  const names: Record<string, string> = {
    [agentIds.buyer]: "Buyer Agent DAO LLC",
    [agentIds.seller]: "Seller Agent DAO LLC",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      if (!href.startsWith(`${LOOKUP_BASE}/`)) return realFetch(url, init);
      looked.push(href);
      const id = href.split("/").at(-1) as string;
      return new Response(
        JSON.stringify({
          agentId: id,
          legalBody: true,
          standing: "active",
          statement: { message: { legalName: names[id] } },
        }),
        { status: 200 },
      );
    }),
  );
  return looked;
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pilot-job-cli-int-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** Runs one command line; returns what it printed. */
async function run(open: () => PilotContext, cfg: Config, argv: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerPilotCommands(program, open, { readConfig: () => cfg });
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", ...argv]);
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

test("pilot:job --yes on anvil writes a submitted case with three hashes, and pilot:case show prints it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-job-cli-int-db-"));
  const cfg = {
    chainId: anvilChain.id,
    usdc: env.usdcAddr,
    jobContract: env.jobAddr,
    identityRegistry: registry,
    arcExplorerUrl: "https://explorer.example.com",
    maxJobBudget: 10_000_000n,
    pilot: {
      mode: "testnet",
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: LOOKUP_BASE,
      buyerAgentId: agentIds.buyer,
      sellerAgentId: agentIds.seller,
    },
  } as unknown as Config;
  let opened = 0;
  const open = (): PilotContext => {
    opened += 1;
    const db = openDatabase(join(dir, "pilot.db"));
    migrate(db);
    return {
      cfg,
      db,
      cases: new SqlitePilotCaseRepository(db),
      docStore: new FileDocumentStore(join(dir, "docs")),
      publicClient: env.publicClient,
      sendClient: createPublicClient({ chain: anvilChain, transport: http(env.rpcUrl) }),
      wallets: {
        buyer: env.clientWallet,
        seller: env.providerWallet,
        referee: env.evaluatorWallet,
      },
      addresses: { buyer: env.clientAddr, seller: env.providerAddr, referee: env.evaluatorAddr },
      close: () => db.close(),
    } as PilotContext;
  };
  const looked = stubLookups();
  const before = await env.usdcBalanceOf(env.clientAddr);

  const printed = JSON.parse(
    await run(open, cfg, [
      "pilot:job",
      "--label",
      "test case 1",
      "--description-file",
      tempFile("description.txt", "Monthly expense report as a CSV\n"),
      "--deliverable",
      tempFile("deliverable.csv", DELIVERABLE),
      "--yes",
    ]),
  );
  expect(looked).toEqual([
    `${LOOKUP_BASE}/legal-bodies/by-agent/${agentIds.buyer}`,
    `${LOOKUP_BASE}/legal-bodies/by-agent/${agentIds.seller}`,
  ]);
  const row = printed.case;
  const deliverableHash = keccak256(new TextEncoder().encode(DELIVERABLE));
  expect(printed.mode).toBe("testnet");
  expect(row).toMatchObject({
    status: "submitted",
    mode: "testnet",
    buyerAgentId: agentIds.buyer,
    sellerAgentId: agentIds.seller,
    budgetAtomic: "2000000",
    deliverableHash,
    deliverableExtension: "csv",
  });
  for (const h of [row.createTxHash, row.fundTxHash, row.submitTxHash])
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  expect(new Set([row.createTxHash, row.fundTxHash, row.submitTxHash]).size).toBe(3);
  expect(new FileDocumentStore(join(dir, "docs")).get(row.deliverablePath)).toBe(DELIVERABLE);

  // The chain agrees: the mock holds the job at Submitted, with the deliverable's hash.
  const jobId = BigInt(row.jobId);
  const job = await env.publicClient.readContract({
    address: env.jobAddr,
    abi: mockErc8183JobAbi,
    functionName: "getJob",
    args: [jobId],
  });
  expect(job).toMatchObject({
    client: env.clientAddr,
    provider: env.providerAddr,
    evaluator: env.evaluatorAddr,
    budget: 2_000_000n,
    status: 2,
  });
  expect(
    await env.publicClient.readContract({
      address: env.jobAddr,
      abi: mockErc8183JobAbi,
      functionName: "deliverableOf",
      args: [jobId],
    }),
  ).toBe(deliverableHash);
  expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before - 2_000_000n);

  // A second command, over a fresh context on the same database file, prints that row.
  const shown = JSON.parse(await run(open, cfg, ["pilot:case", "show", row.caseId]));
  expect(shown.case).toEqual(row);
  expect(shown.events).toMatchObject([
    { step: "create", status: "mined", ref: row.createTxHash },
    { step: "setBudget", status: "mined" },
    { step: "fund", status: "mined", ref: row.fundTxHash },
    { step: "submit", status: "mined", ref: row.submitTxHash },
  ]);
  expect(shown.courtUrl).toBeNull();
  expect(opened).toBe(2);
});
