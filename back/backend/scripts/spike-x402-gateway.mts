// backend/scripts/spike-x402-gateway.mts
//
// Phase 0 spike — exploratory; safe to delete after findings are recorded in
// docs/research/2026-06-16-x402-gateway-spike-findings.md.
//
// TASK 0.2 (this file, current): the non-custodial linchpin. Prove our Turnkey-backed OperatorSigner
// can produce a valid x402 "exact"/EIP-3009 `TransferWithAuthorization` signature on Arc, and that the
// signature recovers to the operator address. NO money moves here — pure off-chain signing + recovery.
//
// Key spike findings baked in below (verified against x402@1.2.0 internals):
//   - x402 EVM signer type is `EvmSigner = SignerWallet | LocalAccount`; the whole EVM signing path
//     reduces to `account.signTypedData(typedData)`. Our `@turnkey/viem` account is a LocalAccount,
//     so it satisfies x402 structurally with the key never leaving the enclave.
//   - x402@1.2.0 does NOT know Arc (chainId 5042002 is absent from its EvmNetworkToChainId map), so its
//     high-level helpers (createPaymentHeader/signAuthorization) throw at getNetworkId("arc-testnet").
//     => We reuse x402's REAL `authorizationTypes` shape but supply chainId ourselves. That is exactly
//        the `signX402()` seam Phase 1 depends on.
//
// Run: cd backend && npx tsx scripts/spike-x402-gateway.mts

import "dotenv/config";
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { BatchEvmScheme, CHAIN_CONFIGS, GatewayClient } from "@circle-fin/x402-batching/client";
import {
  http,
  type Address,
  type Hex,
  type TypedDataDefinition,
  createPublicClient,
  getAddress,
  toHex,
  verifyTypedData,
} from "viem";
import { evm } from "x402/types";
import { buildOperatorSigner } from "../src/adapters/turnkey/operatorSigner";
import { type Config, loadConfig } from "../src/config/env";

// EIP712Domain for the Turnkey path — @turnkey/viem does NOT auto-derive it (Task 0.2 finding), and
// Circle's BatchEvmScheme omits it too, so our BatchEvmSigner adapter injects it before signing.
const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

function createNonce(): Hex {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Read the token's EIP-712 domain (name/version) so the recorded typed data is authoritative. */
async function readUsdcDomain(rpcUrl: string, chainId: number, usdc: `0x${string}`) {
  const client = createPublicClient({
    chain: {
      id: chainId,
      name: "arc-testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  });
  // EIP-5267 first (returns name + version in one call), then fall back to name()/version().
  try {
    const r = (await client.readContract({
      address: usdc,
      abi: [
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
      ],
      functionName: "eip712Domain",
    })) as readonly unknown[];
    return { name: r[1] as string, version: r[2] as string, source: "eip712Domain (EIP-5267)" };
  } catch {
    try {
      const [name, version] = await Promise.all([
        client.readContract({
          address: usdc,
          abi: [
            {
              type: "function",
              name: "name",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "string" }],
            },
          ],
          functionName: "name",
        }) as Promise<string>,
        client.readContract({
          address: usdc,
          abi: [
            {
              type: "function",
              name: "version",
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "string" }],
            },
          ],
          functionName: "version",
        }) as Promise<string>,
      ]);
      return { name, version, source: "name()+version()" };
    } catch {
      return { name: "USDC", version: "2", source: "DEFAULT FALLBACK (on-chain read failed)" };
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const signer = await buildOperatorSigner(cfg);
  console.log("=== Task 0.2: x402 EIP-3009 signing via the OperatorSigner seam ===");
  console.log(
    "signer type    :",
    signer.constructor.name,
    cfg.turnkey ? "(Turnkey enclave — non-custodial)" : "(LocalKey fallback)",
  );
  console.log("operator address:", signer.address);

  const usdc = getAddress(cfg.usdc);
  const domainMeta = await readUsdcDomain(cfg.rpcUrl, cfg.chainId, usdc);
  console.log(
    `USDC domain     : name=${JSON.stringify(domainMeta.name)} version=${JSON.stringify(domainMeta.version)} [${domainMeta.source}]`,
  );

  // Build the x402 "exact"/EIP-3009 authorization typed data, reusing x402's REAL `authorizationTypes`.
  // chainId is supplied directly (x402 has no Arc network entry) — this is the signX402 seam in miniature.
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: signer.address,
    to: cfg.guardianAddress ? getAddress(cfg.guardianAddress) : signer.address, // recipient is irrelevant to signing/recovery
    value: 1n, // 0.000001 USDC (6 decimals) — a nanopayment; nothing settles here
    validAfter: 0n,
    validBefore: BigInt(now + 3600),
    nonce: createNonce(),
  };
  // EIP712Domain (module-scope) is declared explicitly because the Turnkey path does not auto-derive it.
  const typedData = {
    types: { EIP712Domain, ...evm.authorizationTypes },
    domain: {
      name: domainMeta.name,
      version: domainMeta.version,
      chainId: cfg.chainId,
      verifyingContract: usdc,
    },
    primaryType: "TransferWithAuthorization" as const,
    message,
  } satisfies TypedDataDefinition;

  const signature = await signer.signWalletSet(typedData);
  console.log("signature       :", signature);

  const recovered = await verifyTypedData({
    address: signer.address,
    domain: {
      name: domainMeta.name,
      version: domainMeta.version,
      chainId: cfg.chainId,
      verifyingContract: usdc,
    },
    // EIP712Domain is omitted here on purpose: viem auto-derives it for verification (same digest). It is
    // only needed in the *signing* types above, where the Turnkey path does not auto-derive it.
    types: evm.authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message,
    signature,
  });
  console.log("recovery valid  :", recovered, "(verifyTypedData against operator address)");

  console.log("\n--- typed data signed (record this shape for Phase 1) ---");
  console.log(JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  if (!recovered) {
    console.error("\n❌ FAIL: signature did not recover to the operator address.");
    process.exit(1);
  }
  console.log(
    "\n✅ PASS: the Turnkey OperatorSigner produced a valid x402 EIP-3009 authorization that recovers to the operator. Non-custodial x402 signing is proven on Arc.",
  );
}

// ---------------------------------------------------------------------------------------------------
// TASK 0.3 — real settlement on Arc testnet via Circle Gateway batching (run with `--settle`).
//
// SPENDS REAL TESTNET USDC. Proves the off-chain-authorization -> on-chain-settlement rail end to end:
// deposit USDC into the Gateway Wallet, then do a same-chain instant withdraw, which signs a burn intent
// (EIP-712), gets a Circle Gateway API attestation, and calls `gatewayMint` on Arc -> a verifiable mint tx.
//
// ⚠️ Non-custodial gap (spike finding): `GatewayClient` takes a RAW privateKey. For the spike we use the
// funded PLATFORM key. Production must NOT — the burn intent is EIP-712 (signable via the Turnkey seam,
// exactly like Task 0.2), so the non-custodial path reconstructs deposit/burn-intent/mint with the
// Turnkey signer + GATEWAY_DOMAINS/CHAIN_CONFIGS rather than handing a key to GatewayClient. (Phase 2.)
const DEPOSIT = "3";
const WITHDRAW = "2.5"; // must exceed the Gateway fee (default maxFee cap 2.01 USDC)

async function runSettlement(cfg: Config) {
  console.log("\n=== Task 0.3: real Gateway settlement on Arc testnet (SPENDS TESTNET USDC) ===");
  const gateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: cfg.platformPrivateKey,
    rpcUrl: cfg.rpcUrl,
  });
  console.log(
    "payer (PLATFORM key, raw — spike only):",
    gateway.address,
    "| Gateway domain:",
    gateway.domain,
  );

  const before = await gateway.getBalances();
  console.log(
    `before: wallet ${before.wallet.formatted} USDC | gateway available ${before.gateway.formattedAvailable}`,
  );

  console.log(`\ndepositing ${DEPOSIT} USDC into the Gateway Wallet...`);
  const dep = await gateway.deposit(DEPOSIT);
  console.log(
    "  deposit tx:",
    dep.depositTxHash,
    dep.approvalTxHash ? `(approval ${dep.approvalTxHash})` : "",
  );

  // Wait for Circle's API to observe the deposit and make it available.
  let available = 0;
  for (let i = 0; i < 30; i++) {
    const b = await gateway.getBalances();
    available = Number(b.gateway.formattedAvailable);
    process.stdout.write(`  gateway available: ${b.gateway.formattedAvailable} USDC\r`);
    if (available >= Number(WITHDRAW)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("");
  if (available < Number(WITHDRAW))
    throw new Error(`deposit not available after polling (got ${available})`);

  console.log(
    `withdrawing ${WITHDRAW} USDC same-chain (burn intent -> attestation -> gatewayMint)...`,
  );
  const wd = await gateway.withdraw(WITHDRAW);
  console.log("  ✅ settlement mint tx:", wd.mintTxHash);
  console.log("  arcscan:", `https://testnet.arcscan.app/tx/${wd.mintTxHash}`);
  console.log(
    `  ${wd.sourceChain} -> ${wd.destinationChain}, recipient ${wd.recipient}, ${wd.formattedAmount} USDC`,
  );

  const after = await gateway.getBalances();
  console.log(
    `after : wallet ${after.wallet.formatted} USDC | gateway available ${after.gateway.formattedAvailable}`,
  );
  console.log(
    "\n✅ PASS (Task 0.3): a burn-intent authorization settled on Arc testnet via Gateway. The nanopayment rail works end-to-end.",
  );
}

// ---------------------------------------------------------------------------------------------------
// TASK 0.2b — re-prove signing against Circle's REAL batching authorization (domain "GatewayWalletBatched",
// verifyingContract = the GatewayWallet contract, NOT the USDC token), using Circle's own `BatchEvmScheme`
// with our Turnkey enclave signer injected as the `BatchEvmSigner`. No hand-built typed data, no raw key —
// this is the production-grade, non-custodial Circle nanopayments signing path. No money moves.
async function proveBatchSigning(cfg: Config) {
  console.log(
    "\n=== Task 0.2b: Circle batching authorization via BatchEvmScheme + Turnkey signer ===",
  );
  const signer = await buildOperatorSigner(cfg);
  const gatewayWallet = CHAIN_CONFIGS.arcTestnet.gatewayWallet;

  // Circle's BatchEvmSigner = { address, signTypedData }. Our Turnkey signer is exactly this shape, except
  // it needs EIP712Domain declared (BatchEvmScheme omits it) — so the adapter injects it before signing.
  const batchSigner = {
    address: signer.address,
    signTypedData: (params: {
      domain: unknown;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      signer.signWalletSet({
        ...params,
        types: { EIP712Domain, ...params.types },
      } as TypedDataDefinition),
  };

  const scheme = new BatchEvmScheme(batchSigner);
  const requirements = {
    scheme: CIRCLE_BATCHING_SCHEME, // "exact"
    network: `eip155:${cfg.chainId}`, // eip155:5042002 — Arc testnet (the batching scheme keys off this, not a fixed list)
    asset: getAddress(cfg.usdc),
    amount: "1", // 1 atomic unit — signing only, nothing settles
    payTo: cfg.guardianAddress ? getAddress(cfg.guardianAddress) : signer.address,
    maxTimeoutSeconds: 60,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: gatewayWallet,
    },
  };

  // BatchEvmScheme builds the real "GatewayWalletBatched" typed data and calls our Turnkey signer.
  const { payload } = await scheme.createPaymentPayload(1, requirements);
  const auth = payload.authorization as {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
  const signature = payload.signature as Hex;
  console.log(
    "signer type     :",
    signer.constructor.name,
    cfg.turnkey ? "(Turnkey enclave — non-custodial)" : "(LocalKey fallback)",
  );
  console.log(
    "batching domain :",
    `name="${CIRCLE_BATCHING_NAME}" version="${CIRCLE_BATCHING_VERSION}" verifyingContract=${gatewayWallet} (GatewayWallet, NOT USDC)`,
  );
  console.log("signature       :", signature);

  const recovered = await verifyTypedData({
    address: signer.address,
    domain: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      chainId: cfg.chainId,
      verifyingContract: gatewayWallet,
    },
    types: evm.authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  });
  console.log("recovery valid  :", recovered, "(verifyTypedData against operator address)");
  if (!recovered) {
    console.error("\n❌ FAIL: Circle batching authorization did not recover to the operator.");
    process.exit(1);
  }
  console.log(
    "\n✅ PASS: the Turnkey enclave signer produced a valid Circle batching authorization (GatewayWalletBatched) through Circle's own BatchEvmScheme — non-custodial Circle nanopayments signing is proven on Arc.",
  );
}

async function run() {
  const cfg = loadConfig();
  await main();
  await proveBatchSigning(cfg);
  if (process.argv.includes("--settle")) await runSettlement(cfg);
  else
    console.log(
      "\n(skipping Task 0.3 settlement — re-run with `--settle` to spend testnet USDC and prove the rail.)",
    );
}

run().catch((err) => {
  console.error("spike error:", err);
  process.exit(1);
});
