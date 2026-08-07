/**
 * Tier-0 P2 — Probe F: setAgentWallet with an ERC-1271 (Circle SCA) signature against the LIVE
 * Arc registry code, on an anvil fork. Answers the spec's "known unknown that gates NEW circle
 * agents": does the registry's signature check accept a smart-account signature via
 * isValidSignature, or does it ecrecover-only (in which case the circle bind is impossible and
 * P1 must sidestep)?
 *
 * Prereqs: `anvil --fork-url $ARC_TESTNET_RPC_URL --chain-id 5042002 --port 8547` running, and
 * the SCA DEPLOYED on the forked chain (Probe B did that on the real testnet before the fork).
 * The Circle signature is REAL (MPC over the same chainId + registry address, so it verifies
 * identically on the fork).
 *
 * Run: npx tsx scripts/tier0-p2-fork-bind.mts
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { iIdentityRegistryAbi } from "../src/abis/generated";
import { buildWalletSetTypedData } from "../src/adapters/arc/walletSet";
import { chainFor } from "../src/chains";
import type { Address, Hex } from "../src/types";

const require_ = createRequire(import.meta.url);
const dcw = require_("@circle-fin/developer-controlled-wallets");

const FORK_RPC = "http://127.0.0.1:8547";
const CHAIN_ID = 5042002;
const REGISTRY = (process.env.IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;
// anvil default account #0 — plays the manager/NFT-owner role on the fork.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const eip5267Abi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

async function main() {
  const client = dcw.initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
  const list = await client.listWallets({
    walletSetId: process.env.CIRCLE_WALLET_SET_ID,
    pageSize: 50,
  });
  const sca = (list.data?.wallets ?? []).find(
    (w: { accountType: string }) => w.accountType === "SCA",
  );
  if (!sca) throw new Error("no SCA in the wallet set");
  console.log(`SCA: ${sca.address}`);

  const owner = privateKeyToAccount(OWNER_KEY);
  const chain = chainFor(CHAIN_ID, FORK_RPC);
  const pub = createPublicClient({ chain, transport: http(FORK_RPC) });
  const wallet = createWalletClient({ account: owner, chain, transport: http(FORK_RPC) });

  // Sanity: the SCA must have code on the fork (deployed on the real chain before forking).
  const code = await pub.getCode({ address: sca.address as Address });
  if (!code || code === "0x") throw new Error("SCA has no code on the fork — run Probe B first");

  // 1. Use an EXISTING live agent (register() reverts for arbitrary EOAs on the live registry —
  //    agents are minted through the platform flow). On the throwaway fork we impersonate the
  //    agent's real owner, which is MORE faithful anyway: real registry state, real agent row.
  const agentId = BigInt(process.env.P2_FORK_AGENT_ID ?? "845775"); // TestBootstrapMB_1
  const realOwner = await pub.readContract({
    address: REGISTRY,
    abi: iIdentityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
  });
  await fetch(FORK_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "anvil_impersonateAccount", params: [realOwner] },
      { jsonrpc: "2.0", id: 2, method: "anvil_setBalance", params: [realOwner, "0x8AC7230489E80000"] },
    ]),
  });
  console.log(`agentId=${agentId} realOwner=${realOwner} (impersonated on fork)`);

  // 2. Build the AgentWalletSet typed data with the LIVE domain (read via EIP-5267 on the fork).
  const [, domainName, domainVersion] = await pub.readContract({
    address: REGISTRY,
    abi: eip5267Abi,
    functionName: "eip712Domain",
  });
  const block = await pub.getBlock({ blockTag: "latest" });
  const deadline = block.timestamp + 180n;
  const td = buildWalletSetTypedData({
    agentId,
    newWallet: sca.address as Address,
    owner: realOwner,
    deadline,
    chainId: CHAIN_ID,
    registry: REGISTRY,
    domainName,
    domainVersion,
  });

  // 3. REAL Circle MPC signature from the SCA over that digest.
  const sig = await client.signTypedData({
    walletId: sca.id,
    data: JSON.stringify(td, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const signature = sig.data?.signature as Hex;
  console.log(`SCA signature: ${(signature.length - 2) / 2} bytes`);

  // 4. The moment of truth: setAgentWallet(agentId, SCA, deadline, sig) from the owner.
  try {
    await pub.simulateContract({
      account: realOwner,
      address: REGISTRY,
      abi: iIdentityRegistryAbi,
      functionName: "setAgentWallet",
      args: [agentId, sca.address as Address, deadline, signature],
    });
    const impersonated = createWalletClient({ account: realOwner, chain, transport: http(FORK_RPC) });
    const bindHash = await impersonated.writeContract({
      address: REGISTRY,
      abi: iIdentityRegistryAbi,
      functionName: "setAgentWallet",
      args: [agentId, sca.address as Address, deadline, signature],
      gas: 500_000n,
    });
    await pub.waitForTransactionReceipt({ hash: bindHash });
    const bound = await pub.readContract({
      address: REGISTRY,
      abi: iIdentityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    });
    console.log(
      `\nVERDICT: BIND ACCEPTED — getAgentWallet(${agentId}) = ${bound} ` +
        `(${bound.toLowerCase() === sca.address.toLowerCase() ? "MATCHES the SCA — ERC-1271 path CONFIRMED against live registry code" : "UNEXPECTED MISMATCH"})`,
    );
  } catch (e) {
    console.log(
      `\nVERDICT: BIND REJECTED — the live registry does NOT accept the SCA signature.\n` +
        `Revert: ${(e as Error).message.split("\n").slice(0, 4).join("\n")}\n` +
        `Consequence: circle-path onboarding cannot 1271-bind; P1 must sidestep (e.g. EOA-assisted bind or registry-side change).`,
    );
  }
}

main().catch((e) => {
  console.error("fork probe failed:", e);
  process.exit(1);
});
