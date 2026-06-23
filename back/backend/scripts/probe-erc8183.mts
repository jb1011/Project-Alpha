// backend/scripts/probe-erc8183.mts
// Task 0.1: Probe the live ERC-8183 Job + ERC-8004 ReputationRegistry on Arc testnet.
// Read-only. No transactions, no spend.
import "dotenv/config";
import { http, createPublicClient } from "viem";

const RPC = process.env.ARC_TESTNET_RPC_URL!;

const JOB_PROXY = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
const JOB_IMPL = "0xa316fd02827242d537f84730f8a37d0ba5fd351a" as const;
const REP_PROXY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;
const REP_IMPL = "0x16e0fa7f7c56b9a767e34b192b51f921be31da34" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const; // Arc testnet USDC — confirmed via paymentToken() on-chain

const client = createPublicClient({ transport: http(RPC) });

const JOB_ABI = [
  {
    type: "function",
    name: "jobCounter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "paymentToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "platformFeeBP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "evaluatorFeeBP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "platformTreasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "client", type: "address" },
          { name: "provider", type: "address" },
          { name: "evaluator", type: "address" },
          { name: "description", type: "string" },
          { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ],
      },
    ],
  },
] as const;

const REP_ABI = [
  {
    type: "function",
    name: "getIdentityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getVersion",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
    ],
    outputs: [{ type: "uint64" }],
  },
] as const;

async function fetchAbi(address: string) {
  const url = `https://testnet.arcscan.app/api?module=contract&action=getabi&address=${address}`;
  const res = await fetch(url);
  const data = (await res.json()) as { message: string; result: string; status: string };
  if (data.status !== "1") {
    console.error("ABI fetch failed:", data.result);
    return null;
  }
  return data;
}

async function fetchSource(
  address: string,
): Promise<{ ContractName: string; IsProxy: string; SourceCode: string } | undefined> {
  const url = `https://testnet.arcscan.app/api?module=contract&action=getsourcecode&address=${address}`;
  const res = await fetch(url);
  const data = (await res.json()) as { result: Array<Record<string, unknown>> };
  return data.result[0] as
    | { ContractName: string; IsProxy: string; SourceCode: string }
    | undefined;
}

async function main() {
  console.log("=== ERC-8183 Job + ERC-8004 ReputationRegistry Probe ===");
  console.log("Date:", new Date().toISOString());
  console.log("RPC:", RPC.replace(/swrm_[^/]+/, "swrm_***"));
  console.log("");

  // ── 1. Contract addresses ──────────────────────────────────────────────────
  console.log("=== CONTRACT ADDRESSES ===");
  console.log("Job Proxy:        ", JOB_PROXY);
  console.log("Job Impl:         ", JOB_IMPL);
  console.log("RepReg Proxy:     ", REP_PROXY);
  console.log("RepReg Impl:      ", REP_IMPL);
  console.log("");

  // ── 2. Verify proxy → impl linkage on-chain ────────────────────────────────
  console.log("=== PROXY IMPL SLOTS (on-chain) ===");
  const EIP1967_SLOT =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as `0x${string}`;

  const jobImplSlot = await client.getStorageAt({ address: JOB_PROXY, slot: EIP1967_SLOT });
  const repImplSlot = await client.getStorageAt({ address: REP_PROXY, slot: EIP1967_SLOT });
  const jobImplOnChain = `0x${(jobImplSlot ?? "").slice(-40)}`;
  const repImplOnChain = `0x${(repImplSlot ?? "").slice(-40)}`;
  console.log("Job proxy → impl (on-chain):", jobImplOnChain);
  console.log("RepReg proxy → impl (on-chain):", repImplOnChain);
  console.log("");

  // ── 3. Live job state reads ────────────────────────────────────────────────
  console.log("=== LIVE JOB STATE READS ===");

  const jobCounter = await client
    .readContract({
      address: JOB_PROXY,
      abi: JOB_ABI,
      functionName: "jobCounter",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("jobCounter():", jobCounter);

  const paymentToken = await client
    .readContract({
      address: JOB_PROXY,
      abi: JOB_ABI,
      functionName: "paymentToken",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("paymentToken():", paymentToken);
  console.log("  (expected USDC:", USDC, ")");
  console.log("  match:", (paymentToken as string)?.toLowerCase() === USDC.toLowerCase());

  const platformFeeBP = await client
    .readContract({
      address: JOB_PROXY,
      abi: JOB_ABI,
      functionName: "platformFeeBP",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("platformFeeBP():", platformFeeBP, "(", Number(platformFeeBP) / 100, "%)");

  const evaluatorFeeBP = await client
    .readContract({
      address: JOB_PROXY,
      abi: JOB_ABI,
      functionName: "evaluatorFeeBP",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("evaluatorFeeBP():", evaluatorFeeBP, "(", Number(evaluatorFeeBP) / 100, "%)");

  const treasury = await client
    .readContract({
      address: JOB_PROXY,
      abi: JOB_ABI,
      functionName: "platformTreasury",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("platformTreasury():", treasury);
  console.log("");

  // ── 4. Read an existing job if any ────────────────────────────────────────
  if (typeof jobCounter === "bigint" && jobCounter > 0n) {
    console.log("=== SAMPLE JOB (jobId=1) ===");
    const job = await client
      .readContract({
        address: JOB_PROXY,
        abi: JOB_ABI,
        functionName: "getJob",
        args: [1n],
      })
      .catch((e: Error) => `READ_FAILED: ${e.message}`);
    console.log(
      "getJob(1):",
      JSON.stringify(job, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
  } else {
    console.log("=== NO JOBS YET (jobCounter=0) ===");
  }
  console.log("");

  // ── 5. ReputationRegistry reads ───────────────────────────────────────────
  console.log("=== REPUTATION REGISTRY READS ===");

  const identityReg = await client
    .readContract({
      address: REP_PROXY,
      abi: REP_ABI,
      functionName: "getIdentityRegistry",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("getIdentityRegistry():", identityReg);

  const repOwner = await client
    .readContract({
      address: REP_PROXY,
      abi: REP_ABI,
      functionName: "owner",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("owner():", repOwner);

  const version = await client
    .readContract({
      address: REP_PROXY,
      abi: REP_ABI,
      functionName: "getVersion",
    })
    .catch((e: Error) => `READ_FAILED: ${e.message}`);
  console.log("getVersion():", version);
  console.log("");

  // ── 6. Verified ABI check via explorer ────────────────────────────────────
  console.log("=== EXPLORER ABI STATUS ===");
  const jobAbiResp = await fetchAbi(JOB_PROXY);
  console.log("Job proxy ABI status:", jobAbiResp?.message, "(proxy-only, fallback only)");

  const jobImplAbiResp = await fetchAbi(JOB_IMPL);
  if (!jobImplAbiResp) {
    console.error("Job impl ABI fetch failed");
    process.exit(1);
  }
  console.log("Job impl ABI status:", jobImplAbiResp.message);
  const jobImplAbi = JSON.parse(jobImplAbiResp.result) as Array<{ type: string; name: string }>;
  const jobFunctions = jobImplAbi.filter((x) => x.type === "function").map((x) => x.name);
  console.log("Job impl functions:", jobFunctions.join(", "));

  const repImplAbiResp = await fetchAbi(REP_IMPL);
  if (!repImplAbiResp) {
    console.error("RepReg impl ABI fetch failed");
    process.exit(1);
  }
  console.log("RepReg impl ABI status:", repImplAbiResp.message);
  const repImplAbi = JSON.parse(repImplAbiResp.result) as Array<{ type: string; name: string }>;
  const repFunctions = repImplAbi.filter((x) => x.type === "function").map((x) => x.name);
  console.log("RepReg impl functions:", repFunctions.join(", "));
  console.log("");

  // ── 7. Source verification ─────────────────────────────────────────────────
  console.log("=== SOURCE VERIFICATION ===");
  const jobSrc = await fetchSource(JOB_IMPL);
  if (jobSrc) {
    console.log("Job impl contract name:", jobSrc.ContractName);
    console.log("Job impl is proxy:", jobSrc.IsProxy);
    const jobSourceCode = jobSrc.SourceCode;
    console.log("fund:", jobSourceCode.match(/function fund[\s\S]{0,400}/)?.[0]);
    console.log("submit:", jobSourceCode.match(/function submit[\s\S]{0,400}/)?.[0]);
    console.log("complete:", jobSourceCode.match(/function complete[\s\S]{0,400}/)?.[0]);
  }

  const repSrc = await fetchSource(REP_IMPL);
  if (repSrc) {
    console.log("RepReg impl contract name:", repSrc.ContractName);
    console.log("RepReg impl is proxy:", repSrc.IsProxy);
    const repSourceCode = repSrc.SourceCode;
    console.log("giveFeedback:", repSourceCode.match(/function giveFeedback[\s\S]{0,400}/)?.[0]);
  }
  console.log("");

  console.log("=== PROBE COMPLETE ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
