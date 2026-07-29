import { addEnsContracts } from "@ensdomains/ensjs";
import { getOwner, getPrice } from "@ensdomains/ensjs/public";
import { randomSecret } from "@ensdomains/ensjs/utils";
import { commitName, registerName } from "@ensdomains/ensjs/wallet";
/**
 * ENS name registration (Sepolia) — hackathon build 1 (ENS), task T1.
 *
 * ⚠️ CURRENTLY NON-FUNCTIONAL ON SEPOLIA (2026-07-24). ENS rotated the Sepolia
 * registrar controllers: ensjs 4.3.1 (and the ENS wiki) point at controller
 * 0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968, which is NO LONGER authorized on
 * the BaseRegistrar (0x57f1887a…) — register() reverts with empty data via a
 * message-less require(controllers[msg.sender]). The only live authorized
 * controller with a register() fn is 0xdf60C561Ca35AD3C89D24BbA854654b1c3477078,
 * which has a NEW ABI (rentPrice/commit/makeCommitment moved) that ensjs 4.3.1
 * doesn't speak. Until ensjs ships a working Sepolia build, register the parent
 * name via the ENS app (https://sepolia.app.ens.domains) in the browser, which
 * uses the correct current controller. Everything downstream (resolver deploy,
 * setResolver, gateway, records) is controller-independent and works normally.
 * See back/docs/ethglobal-lisbon-2026/reference-ens.md §9.
 *
 * Registers `novicorpus.eth` (or ENS_PARENT_NAME) on Sepolia via the current
 * 2025 unwrapped ETHRegistrarController, using ensjs 4.3.1.
 *
 * Reads from env (put these in back/backend/.env — it is git-ignored):
 *   ENS_OWNER_KEY    0x-prefixed private key of the funded Sepolia manager EOA
 *                    (the same key must later deploy the resolver + setResolver)
 *   SEPOLIA_RPC_URL  Sepolia RPC (e.g. https://ethereum-sepolia-rpc.publicnode.com)
 *   ENS_PARENT_NAME  optional, defaults to "novicorpus.eth"
 *
 * Run:  cd back/backend && npx tsx scripts/ens-register.mts
 *
 * NOTE: commit is only valid 60s–24h. This script commits, waits 75s, then
 * registers in one sitting. If it fails after committing, just re-run it
 * (a fresh commit/secret is generated each run).
 */
import { http, createPublicClient, createWalletClient, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC_URL;
const KEY = process.env.ENS_OWNER_KEY as `0x${string}` | undefined;
const NAME = process.env.ENS_PARENT_NAME ?? "novicorpus.eth";
const DURATION = 31_536_000; // 1 year (min is 28 days)

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!RPC) fail("SEPOLIA_RPC_URL not set (add it to back/backend/.env)");
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY))
  fail("ENS_OWNER_KEY missing or malformed (expect 0x + 64 hex chars, in back/backend/.env)");

const chain = addEnsContracts(sepolia);
const account = privateKeyToAccount(KEY);
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

async function main() {
  console.log(`\nENS registration — ${NAME} on Sepolia`);
  console.log(`Manager address: ${account.address}`);

  // Preflight: balance + availability.
  const balance = await client.getBalance({ address: account.address });
  console.log(`Balance:         ${formatEther(balance)} SepoliaETH`);
  if (balance === 0n)
    fail(`This address has no Sepolia ETH. Fund ${account.address} via a Sepolia faucet first.`);

  const existingOwner = await getOwner(client, { name: NAME }).catch(() => null);
  if (
    existingOwner?.owner &&
    existingOwner.owner !== "0x0000000000000000000000000000000000000000"
  ) {
    if (existingOwner.owner.toLowerCase() === account.address.toLowerCase()) {
      console.log(`\n✓ ${NAME} is ALREADY owned by this address — nothing to do.`);
      console.log(`  ownershipLevel: ${existingOwner.ownershipLevel}`);
      return;
    }
    fail(
      `${NAME} is already registered to ${existingOwner.owner} (not us). Pick another parent name.`,
    );
  }

  // Resume mode: if ENS_COMMIT_SECRET is set, reuse the existing on-chain
  // commitment (valid 60s–24h) and skip straight to register.
  const resumeSecret = process.env.ENS_COMMIT_SECRET as `0x${string}` | undefined;
  const secret = resumeSecret ?? randomSecret();
  const params = { name: NAME, owner: account.address, duration: DURATION, secret } as const;

  const { base, premium } = await getPrice(client, { nameOrNames: NAME, duration: DURATION });
  const value = ((base + premium) * 110n) / 100n; // +10% buffer; controller refunds excess
  console.log(
    `Price (1yr):     ${formatEther(base + premium)} ETH  (sending ${formatEther(value)} w/ buffer)`,
  );
  if (balance < value)
    fail(`Insufficient balance for registration (need ~${formatEther(value)} ETH).`);

  if (resumeSecret) {
    console.log(
      `\nRESUME: reusing existing commitment (secret ${secret.slice(0, 10)}…), skipping commit.`,
    );
  } else {
    console.log(`\nSECRET (save to retry register without re-committing): ${secret}`);
    console.log("\n[1/2] Committing...");
    const commitTx = await commitName(wallet, params);
    console.log(`  commit tx: ${commitTx}`);
    await client.waitForTransactionReceipt({ hash: commitTx });
    console.log("  committed. Waiting 75s (min commitment age 60s)...");
    await new Promise((r) => setTimeout(r, 75_000));
  }

  console.log("[2/2] Registering...");
  const registerTx = await registerName(wallet, { ...params, value });
  console.log(`  register tx: ${registerTx}`);
  await client.waitForTransactionReceipt({ hash: registerTx });

  console.log(`\n✓ Registered ${NAME}`);
  console.log(`  View: https://sepolia.app.ens.domains/${NAME}`);
  console.log("  Next (T2): deploy the resolver, then run the set-resolver step.");
}

main().catch((e) => {
  console.error("\n✗ registration failed");
  if (e?.shortMessage) console.error("  shortMessage:", e.shortMessage);
  if (e?.details) console.error("  details:", e.details);
  if (Array.isArray(e?.metaMessages)) console.error("  meta:", e.metaMessages.join(" | "));
  const cause = e?.cause;
  if (cause) {
    if (cause.reason) console.error("  cause.reason:", cause.reason);
    if (cause.shortMessage) console.error("  cause.shortMessage:", cause.shortMessage);
    if (cause.data) console.error("  cause.data:", JSON.stringify(cause.data));
    if (cause.signature) console.error("  cause.signature:", cause.signature);
    const c2 = cause.cause;
    if (c2?.data)
      console.error(
        "  cause.cause.data:",
        typeof c2.data === "string" ? c2.data : JSON.stringify(c2.data),
      );
    if (c2?.reason) console.error("  cause.cause.reason:", c2.reason);
  }
  process.exit(1);
});
