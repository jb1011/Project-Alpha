/**
 * ENS V2 name registration (Sepolia) — hackathon build 1, task T1 (V2 path).
 *
 * ENS launched V2: registration is now SINGLE-STEP (no commit-reveal) via the
 * new controller 0xdf60C561Ca35AD3C89D24BbA854654b1c3477078 (the only authorized
 * BaseRegistrar controller with a register() fn; ensjs/wiki are stale). Verified
 * by on-chain trace: register((string,address,uint256,bytes32,address,bytes[],
 * uint8,bytes32)) succeeds in one call, sets the resolver we pass, mints to owner.
 *
 * Dry-runs (simulate, no spend) by default. Set SEND=1 to broadcast.
 * Reads ENS_OWNER_KEY, SEPOLIA_RPC_URL, ENS_PARENT_NAME, ENS_RESOLVER_ADDRESS from .env.
 *   cd back/backend && npx tsx --env-file=.env scripts/ens-register-v2.mts        # dry run
 *   cd back/backend && SEND=1 npx tsx --env-file=.env scripts/ens-register-v2.mts # broadcast
 */
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  formatEther,
  namehash,
  parseEther,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const CONTROLLER = "0xdf60C561Ca35AD3C89D24BbA854654b1c3477078" as const; // ENS V2 Sepolia controller
const CLASSIC_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const DURATION = 31_536_000n; // 1 year
const VALUE = parseEther("0.05"); // over-send; excess is refunded

const RPC = process.env.SEPOLIA_RPC_URL;
const KEY = process.env.ENS_OWNER_KEY as Hex | undefined;
const NAME = process.env.ENS_PARENT_NAME ?? "novicorpus.eth";
const RESOLVER = process.env.ENS_RESOLVER_ADDRESS as Address | undefined;

const fail = (m: string): never => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};
if (!RPC) fail("SEPOLIA_RPC_URL not set");
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) fail("ENS_OWNER_KEY missing/malformed");
if (!RESOLVER || !/^0x[0-9a-fA-F]{40}$/.test(RESOLVER))
  fail("ENS_RESOLVER_ADDRESS missing/malformed");

const account = privateKeyToAccount(KEY as Hex);
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ chain: sepolia, transport: http(RPC), account });
const label = NAME.replace(/\.eth$/, "");

const registerAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "registration",
        type: "tuple",
        components: [
          { name: "label", type: "string" },
          { name: "owner", type: "address" },
          { name: "duration", type: "uint256" },
          { name: "secret", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "data", type: "bytes[]" },
          { name: "reverseRecord", type: "uint8" },
          { name: "referrer", type: "bytes32" },
        ],
      },
    ],
  },
] as const;
const registry = [
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

async function main() {
  const reg = {
    label,
    owner: account.address,
    duration: DURATION,
    secret: zeroHash,
    resolver: RESOLVER!,
    data: [] as Hex[],
    reverseRecord: 0,
    referrer: zeroHash,
  };
  console.log(`\nENS V2 registration — ${NAME} on Sepolia (single-step)`);
  console.log(`  owner (manager): ${account.address}`);
  console.log(`  resolver:        ${RESOLVER}`);
  console.log(`  value (max):     ${formatEther(VALUE)} ETH (excess refunded)`);

  const bal = await client.getBalance({ address: account.address });
  console.log(`  balance:         ${formatEther(bal)} ETH`);
  if (bal < VALUE) fail("Insufficient balance for the (refundable) value + gas.");

  console.log("\nSimulating register()...");
  const { request } = await client.simulateContract({
    address: CONTROLLER,
    abi: registerAbi,
    functionName: "register",
    args: [reg],
    account,
    value: VALUE,
  });
  console.log("  ✓ simulation OK — controller accepts our resolver, single call, no commit.");

  if (process.env.SEND !== "1") {
    console.log("\n(dry run) Re-run with SEND=1 to broadcast.");
    return;
  }

  console.log("\nBroadcasting register()...");
  const hash = await wallet.writeContract(request);
  console.log(`  tx: ${hash}`);
  await client.waitForTransactionReceipt({ hash });
  console.log(`\n✓ Registered ${NAME}`);

  // Verify resolution wiring in the CLASSIC registry (what viem/UniversalResolver use).
  const node = namehash(NAME);
  const [owner, resolver] = await Promise.all([
    client
      .readContract({
        address: CLASSIC_REGISTRY,
        abi: registry,
        functionName: "owner",
        args: [node],
      })
      .catch(() => "0x?"),
    client
      .readContract({
        address: CLASSIC_REGISTRY,
        abi: registry,
        functionName: "resolver",
        args: [node],
      })
      .catch(() => "0x?"),
  ]);
  console.log(`  classic registry owner(${NAME}):    ${owner}`);
  console.log(`  classic registry resolver(${NAME}): ${resolver}`);
  console.log(
    resolver && (resolver as string).toLowerCase() === RESOLVER!.toLowerCase()
      ? "  ✓ classic registry points at OUR resolver — CCIP wildcard path will work."
      : "  ⚠ classic registry resolver != ours (V2 may resolve via a different registry). Investigate before building the gateway.",
  );
}

main().catch((e) => {
  console.error("\n✗ failed");
  console.error("  ", e?.shortMessage ?? e?.message ?? String(e));
  if (e?.metaMessages) console.error("  ", e.metaMessages.slice(0, 3).join(" | "));
  process.exit(1);
});
