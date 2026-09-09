/**
 * B1 MERGE GATE — settle a REAL signed authorization on Arc testnet (design §6.9).
 *
 * B1 touches no doola, so it gets its own live gate, and it is the house six-probes precedent
 * applied to money: everything in this feature is verified locally against fakes, and "the
 * signature our quote produces is one the TOKEN accepts" is precisely the claim a fake cannot
 * make. Four things this proves that no test can:
 *
 *   1. the EIP-712 domain we READ from the token is the one it actually verifies against
 *      (`readUsdcDomain` pins `name`/`version` to `DOMAIN_SEPARATOR()`, but only a settled
 *      transfer proves the pin is the right pin);
 *   2. the executor path — `encodeFunctionData` + `signTransaction` + `sendRawTransaction` with
 *      EXPLICIT gas — produces a transaction the chain mines;
 *   3. THE GAS. `TRANSFER_WITH_AUTHORIZATION_GAS` and `CANCEL_AUTHORIZATION_GAS` are bounded
 *      ESTIMATES in `src/adapters/arc/gas.ts` until this prints a real `gasUsed`. Pin them to the
 *      measured figures + ~20% before payment is ever turned on (docs/runbooks/doola-deploy.md);
 *   4. `cancelAuthorization` works, which is the guardian's only exit from a stuck payment.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────────────
 *
 *   a. reads the USDC domain from the chain and pins it;
 *   b. builds a quote's typed data EXACTLY as `quoteOf` does — same helper, so a drift between
 *      the probe and the product is impossible;
 *   c. signs it as the guardian, and verifies it through `verifyTransferAuthorization` — the SAME
 *      function the settle route runs;
 *   d. submits `transferWithAuthorization` through the SAME executor path the route uses, waits
 *      for the receipt, and reads back `authorizationState == true`;
 *   e. signs and submits a `cancelAuthorization` for a SECOND, UNUSED nonce and confirms it,
 *      then reads back `authorizationState == true` for that nonce too.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────────────────────────
 *
 *   PROBE_GUARDIAN_PRIVATE_KEY=0x…   a TEST EOA holding a few testnet USDC (it is the payer)
 *   PROBE_REVENUE_ADDRESS=0x…        a TEST destination — NEVER the production Ledger
 *   PROBE_AMOUNT_USDC=0.10           optional, whole/decimal USDC (default 0.10)
 *   ARC_TESTNET_RPC_URL / PLATFORM_PRIVATE_KEY   from .env, as everywhere else
 *
 *   npx tsx scripts/formation-settle-probe.mts
 *
 * NOT a test: it needs two funded keys and a live chain, so it never runs in CI. It REFUSES any
 * chain id that is not Arc testnet — this script signs real transfers, and the one mistake it
 * must make impossible is being pointed at mainnet.
 */
import "dotenv/config";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { managerWalletClient, publicClientFor } from "../src/adapters/arc/clients";
import {
  CANCEL_AUTHORIZATION_TYPES,
  readAuthorizationState,
  readUsdcDomain,
} from "../src/adapters/arc/usdcToken";
import { ARC_TESTNET_CHAIN_ID, loadConfig } from "../src/config/env";
import { newPaymentNonce, quoteOf } from "../src/formation/payment";
import { broadcastAndConfirm, signCancelTx, signSettleTx } from "../src/payments/formationSettle";
import { verifyTransferAuthorization } from "../src/payments/transferAuthorization";
import type { Address, Hex } from "../src/types";

const cfg = loadConfig();

// ⚠ THE ONE REFUSAL THAT MATTERS. Everything below signs a real USDC transfer.
if (cfg.chainId !== ARC_TESTNET_CHAIN_ID)
  throw new Error(
    `refusing to run: this probe SIGNS AND SETTLES A REAL TRANSFER and is testnet-only. ARC_CHAIN_ID is ${cfg.chainId}, expected ${ARC_TESTNET_CHAIN_ID}`,
  );

const guardianKeyEnv = process.env.PROBE_GUARDIAN_PRIVATE_KEY;
const revenueEnv = process.env.PROBE_REVENUE_ADDRESS;
if (!guardianKeyEnv) throw new Error("PROBE_GUARDIAN_PRIVATE_KEY is required (a funded TEST EOA)");
if (!revenueEnv) throw new Error("PROBE_REVENUE_ADDRESS is required (a TEST destination)");
// Re-bound with the narrowed type so the closures below see it: control-flow narrowing of a
// module-level `const` does not follow a `process.env` read into an async function.
const guardianKey: Hex = guardianKeyEnv as Hex;
const revenue: Address = revenueEnv as Address;
if (revenue.toLowerCase() === (cfg.formation?.payment.revenueAddress ?? "").toLowerCase())
  throw new Error(
    "refusing to run: PROBE_REVENUE_ADDRESS is this deployment's configured FORMATION_REVENUE_ADDRESS. Use a throwaway destination — a probe must not put test transfers into the real revenue trail",
  );

const guardian = privateKeyToAccount(guardianKey);
const publicClient = publicClientFor(cfg);
const executorDeps = {
  publicClient,
  walletClient: managerWalletClient(cfg),
  usdc: cfg.usdc,
  chainId: cfg.chainId,
};
const amount = parseUnits(process.env.PROBE_AMOUNT_USDC ?? "0.10", 6);

/** A payment ROW as the repository would produce one — the probe never touches the database. */
function row(nonce: Hex, validBefore: number) {
  return {
    paymentId: `probe-${nonce.slice(2, 10)}`,
    companyId: "probe",
    product: "formation" as const,
    status: "quoted" as const,
    amountUsdc: amount,
    nonce,
    validBefore,
    payerAddress: null,
    rawTx: null,
    txHash: null,
    attempt: 0,
    refundTxHash: null,
    createdAt: "",
    updatedAt: "",
  };
}

async function main(): Promise<void> {
  console.log(`chain ${cfg.chainId}  usdc ${cfg.usdc}`);
  console.log(`guardian (payer)  ${guardian.address}`);
  console.log(`executor (gas)    ${executorDeps.walletClient.account?.address}`);
  console.log(`revenue (test)    ${revenue}\n`);

  // (a) THE DOMAIN, read and pinned. A mismatch throws here rather than after a signature.
  const domain = await readUsdcDomain(publicClient, cfg.usdc, cfg.chainId);
  console.log(`domain pinned: name="${domain.name}" version="${domain.version}" ✓\n`);

  // (b) THE QUOTE, built by the product's own function.
  const validBefore = Math.floor(Date.now() / 1000) + 30 * 60;
  const nonce = newPaymentNonce();
  const quote = quoteOf(row(nonce, validBefore), guardian.address as Address, {
    revenueAddress: revenue,
    domain,
    feeUsdc: Number(amount / 1_000_000n),
  });
  console.log(`quote: ${quote.amountUsdc} atomic USDC -> ${quote.payTo}, nonce ${quote.nonce}`);

  // (c) THE GUARDIAN'S SIGNATURE, verified through the product's own verifier.
  const td = quote.typedData;
  const signature = (await guardian.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: {
      from: td.message.from,
      to: td.message.to,
      value: BigInt(td.message.value),
      validAfter: BigInt(td.message.validAfter),
      validBefore: BigInt(td.message.validBefore),
      nonce: td.message.nonce,
    },
  })) as Hex;
  const verdict = await verifyTransferAuthorization({
    authorization: td.message,
    signature,
    domain,
    payTo: revenue,
    value: amount,
    mode: "exact",
  });
  if (!verdict.ok) throw new Error(`local verification FAILED: ${verdict.reason}`);
  console.log("local verification ✓\n");

  // (d) THE SETTLE, through the executor path the route uses.
  const settleTx = await signSettleTx(
    executorDeps,
    {
      from: guardian.address as Address,
      to: revenue,
      value: amount,
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    },
    signature,
  );
  console.log(`settle tx ${settleTx.txHash} — broadcasting…`);
  const settled = await broadcastAndConfirm(executorDeps, settleTx);
  if (settled.kind !== "settled") throw new Error(`settle did not confirm: ${settled.kind}`);
  const usedAfterSettle = await readAuthorizationState(
    publicClient,
    cfg.usdc,
    guardian.address as Address,
    nonce,
  );
  console.log(`settled ✓  authorizationState=${usedAfterSettle}`);
  console.log(`\n>>> TRANSFER_WITH_AUTHORIZATION gasUsed = ${settled.gasUsed} <<<\n`);
  if (!usedAfterSettle)
    throw new Error("the transfer confirmed but authorizationState is FALSE — investigate");

  // (e) THE CANCEL, on a SECOND, never-used nonce. A cancel of the settled nonce would revert,
  //     which would tell us nothing about whether cancellation works.
  const cancelNonce = newPaymentNonce();
  const cancelSignature = (await guardian.signTypedData({
    domain,
    types: CANCEL_AUTHORIZATION_TYPES,
    primaryType: "CancelAuthorization",
    message: { authorizer: guardian.address as Address, nonce: cancelNonce },
  })) as Hex;
  const cancelTx = await signCancelTx(
    executorDeps,
    guardian.address as Address,
    cancelNonce,
    cancelSignature,
  );
  console.log(`cancel tx ${cancelTx.txHash} (nonce ${cancelNonce}) — broadcasting…`);
  const cancelled = await broadcastAndConfirm(executorDeps, cancelTx);
  if (cancelled.kind !== "settled") throw new Error(`cancel did not confirm: ${cancelled.kind}`);
  const usedAfterCancel = await readAuthorizationState(
    publicClient,
    cfg.usdc,
    guardian.address as Address,
    cancelNonce,
  );
  console.log(`cancelled ✓  authorizationState=${usedAfterCancel}`);
  console.log(`\n>>> CANCEL_AUTHORIZATION gasUsed = ${cancelled.gasUsed} <<<\n`);
  if (!usedAfterCancel)
    throw new Error("the cancel confirmed but authorizationState is FALSE — investigate");

  console.log(
    "B1 merge gate PASSED. Pin the two gasUsed figures (+~20%) into src/adapters/arc/gas.ts.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
