/**
 * Tier-0 P2 — the one-sitting live testnet experiment
 * (docs/design/2026-08-03-tier0-circle-wallet-migration.md, "P2").
 *
 * Run: npx tsx scripts/tier0-p2-experiment.mts [--leg A|B|C|D|E]
 *
 * Probes (all Arc testnet, ZERO Turnkey signatures, tiny testnet-USDC amounts):
 *   A  counterfactual ERC-1271: does the (possibly undeployed) SCA answer isValidSignature?
 *   B  Gas Station: first contractExecution from the SCA — deploys it, fee sponsored?
 *      then re-run the 1271 check against the DEPLOYED SCA.
 *   C  faucet -> exact-approve -> GatewayWallet.depositFor(usdc, pocket, amount) -> balances.
 *   D  x402 end-to-end with the CIRCLE-SIGNED pocket EOA: 402 -> sign via Circle API ->
 *      facilitator verify+settle through our own buildPaywall seller.
 *   E  SCA queue: two concurrent contractExecutions — serialize, queue, or reject?
 *
 * Uses require() for the Circle SDK (its ESM named exports are broken in plain Node — see
 * src/adapters/circle/circleWallets.ts interop note).
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { http, createPublicClient, encodeFunctionData, formatUnits, hashTypedData } from "viem";
import { submitAndConfirm } from "../src/adapters/circle/circleExec";
import type { CircleWalletsApi } from "../src/adapters/circle/circleWallets";
import { circleTypedDataSigner } from "../src/adapters/circle/circleWallets";
import { arcBatchingConfig, asBatchEvmSigner } from "../src/adapters/x402/pocket";
import { makeSignX402 } from "../src/adapters/x402/signX402";
import { chainFor } from "../src/chains";
import { buildPaywall } from "../src/payments/seller";
import { makeSettle } from "../src/payments/settle";
import type { Address, Hex } from "../src/types";

const require_ = createRequire(import.meta.url);
const dcw = require_("@circle-fin/developer-controlled-wallets");

const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const USDC = (process.env.USDC_ADDRESS ?? arcBatchingConfig.asset) as Address;
const GATEWAY = arcBatchingConfig.verifyingContract;
const FACILITATOR = process.env.GATEWAY_FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com";
const PAY_TO = (process.env.VENDOR_PAYOUT_ADDRESS ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address;

const onlyLeg = process.argv.includes("--leg")
  ? process.argv[process.argv.indexOf("--leg") + 1]?.toUpperCase()
  : undefined;
const want = (leg: string) => !onlyLeg || onlyLeg === leg;

function banner(s: string) {
  console.log(`\n${"━".repeat(70)}\n${s}\n${"━".repeat(70)}`);
}

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const gatewayAbi = [
  {
    type: "function",
    name: "depositFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "availableBalance",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const isValidSigAbi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  if (!apiKey || !entitySecret || !walletSetId)
    throw new Error("CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_SET_ID required");

  const client = dcw.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const api = client as unknown as CircleWalletsApi;
  const pub = createPublicClient({ chain: chainFor(CHAIN_ID, RPC), transport: http(RPC) });

  // ── Recover the P1b wallets from the wallet set (SCA operator + EOA pocket) ──────────────
  const list = await client.listWallets({ walletSetId, pageSize: 50 });
  const wallets = list.data?.wallets ?? [];
  const sca = wallets.find((w: { accountType: string }) => w.accountType === "SCA");
  const eoa = wallets.find((w: { accountType: string }) => w.accountType === "EOA");
  if (!sca || !eoa) throw new Error(`wallet set ${walletSetId} lacks an SCA+EOA pair`);
  console.log(`SCA operator: ${sca.address} (${sca.id}, scaCore=${sca.scaCore})`);
  console.log(`EOA pocket:   ${eoa.address} (${eoa.id})`);

  const confirmOpts = { pollDelayMs: 2_000, timeoutMs: 180_000 };
  const results: Record<string, string> = {};

  // A canonical typed-data payload for the 1271 probes (domain = the Gateway, arbitrary struct).
  // Circle's signTypedData validates the full EIP-712 object, so EIP712Domain must be declared in
  // `types` (viem's hashTypedData ignores it, but the SDK requires it) — same shape our
  // asBatchEvmSigner injects on the real x402 path.
  const probeTypedData = {
    domain: { name: "GatewayWallet", version: "1", chainId: CHAIN_ID, verifyingContract: GATEWAY },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Probe: [{ name: "note", type: "string" }],
    },
    primaryType: "Probe",
    message: { note: "tier0-p2-1271-probe" },
  } as const;
  const probeHash = hashTypedData({
    domain: probeTypedData.domain,
    types: { Probe: probeTypedData.types.Probe },
    primaryType: "Probe",
    message: probeTypedData.message,
  });

  async function check1271(label: string): Promise<string> {
    const code = await pub.getCode({ address: sca.address as Address });
    const deployed = Boolean(code && code !== "0x");
    let scaSig: Hex | undefined;
    let sigErr: string | undefined;
    try {
      const r = await api.signTypedData({
        walletId: sca.id,
        data: JSON.stringify(probeTypedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      scaSig = r.data?.signature as Hex;
    } catch (e) {
      sigErr = (e as Error).message;
    }
    let verdict: string;
    if (!scaSig) {
      verdict = `SIGN-FAILED (${sigErr})`;
    } else {
      try {
        const magic = await pub.readContract({
          address: sca.address as Address,
          abi: isValidSigAbi,
          functionName: "isValidSignature",
          args: [probeHash, scaSig],
        });
        verdict = magic === "0x1626ba7e" ? "VALID (magic value returned)" : `INVALID (${magic})`;
      } catch (e) {
        verdict = `CALL-REVERTED (${(e as Error).message.split("\n")[0]})`;
      }
    }
    const line = `deployed=${deployed} sigBytes=${scaSig ? (scaSig.length - 2) / 2 : "-"} → ${verdict}`;
    console.log(`[1271 ${label}] ${line}`);
    return line;
  }

  // ── Probe A: counterfactual 1271 ─────────────────────────────────────────────────────────
  if (want("A")) {
    banner("Probe A — counterfactual ERC-1271 on the (undeployed?) SCA");
    results.A = await check1271("pre-deploy");
  }

  // ── Probe B: Gas Station + first UserOp (deploys the SCA), then 1271 again ──────────────
  if (want("B")) {
    banner("Probe B — Gas Station sponsorship (approve(GATEWAY, 0) from the SCA)");
    const nativeBefore = await pub.getBalance({ address: sca.address as Address });
    const t0 = Date.now();
    const { circleTxId, txHash } = await submitAndConfirm(
      api,
      {
        walletId: sca.id,
        contractAddress: USDC,
        callData: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [GATEWAY, 0n],
        }),
        idempotencySeed: `p2:gasstation:${Date.now()}`, // fresh per run — this probe is not resumable
      },
      {
        ...confirmOpts,
        onNetworkFee: (fee, id) => console.log(`  networkFee: ${formatUnits(fee, 6)} USDC (${id})`),
      },
    );
    const nativeAfter = await pub.getBalance({ address: sca.address as Address });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  confirmed in ${secs}s: circleTx=${circleTxId} hash=${txHash}`);
    console.log(`  SCA native balance: ${nativeBefore} -> ${nativeAfter} (sponsored if unchanged)`);
    results.B = `confirmed in ${secs}s, native ${nativeBefore}->${nativeAfter}`;
    results.B2 = await check1271("post-deploy");
  }

  // ── Probe C: faucet -> exact approve -> depositFor(pocket) ───────────────────────────────
  if (want("C")) {
    banner("Probe C — faucet USDC to SCA, exact-approve, depositFor(pocket)");
    const AMOUNT = 500_000n; // 0.50 USDC
    let bal = await pub.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [sca.address as Address],
    });
    console.log(`  SCA USDC balance: ${formatUnits(bal, 6)}`);
    if (bal < AMOUNT) {
      // Circle's faucet 403s under our restricted API key — fund from the platform wallet
      // instead, which also mirrors the real bridge's first leg (USDC landing on the SCA).
      // Explicit gas: the Arc estimateGas+EIP-1559 footgun (see PR #33) never gets a chance.
      console.log("  funding SCA from the platform wallet…");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient } = await import("viem");
      const platform = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY as Hex);
      const wallet = createWalletClient({
        account: platform,
        chain: chainFor(CHAIN_ID, RPC),
        transport: http(RPC),
      });
      const fundHash = await wallet.writeContract({
        address: USDC,
        abi: [
          {
            type: "function",
            name: "transfer",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as const,
        functionName: "transfer",
        args: [sca.address as Address, AMOUNT],
        gas: 100_000n,
      });
      await pub.waitForTransactionReceipt({ hash: fundHash });
      bal = await pub.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sca.address as Address],
      });
      console.log(`  SCA USDC after platform transfer: ${formatUnits(bal, 6)} (${fundHash})`);
      if (bal < AMOUNT) throw new Error("platform funding did not land");
    }
    const approve = await submitAndConfirm(
      api,
      {
        walletId: sca.id,
        contractAddress: USDC,
        callData: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [GATEWAY, AMOUNT],
        }),
        idempotencySeed: `p2:approve:${Date.now()}`,
      },
      confirmOpts,
    );
    console.log(`  approve confirmed: ${approve.txHash}`);
    const dep = await submitAndConfirm(
      api,
      {
        walletId: sca.id,
        contractAddress: GATEWAY,
        callData: encodeFunctionData({
          abi: gatewayAbi,
          functionName: "depositFor",
          args: [USDC, eoa.address as Address, AMOUNT],
        }),
        idempotencySeed: `p2:depositFor:${Date.now()}`,
      },
      confirmOpts,
    );
    console.log(`  depositFor confirmed: ${dep.txHash}`);
    const onchain = await pub.readContract({
      address: GATEWAY,
      abi: gatewayAbi,
      functionName: "availableBalance",
      args: [USDC, eoa.address as Address],
    });
    console.log(`  pocket Gateway availableBalance (on-chain): ${formatUnits(onchain, 6)} USDC`);
    results.C = `depositFor OK (${dep.txHash}); pocket on-chain available=${formatUnits(onchain, 6)}`;
  }

  // ── Probe D: x402 verify+settle with the Circle-signed pocket ────────────────────────────
  if (want("D")) {
    banner("Probe D — x402 end-to-end: pocket signs via Circle API, facilitator settles");
    const PRICE = 10_000n; // 0.01 USDC
    const signer = asBatchEvmSigner({
      address: eoa.address as Address,
      signTypedData: (td) =>
        circleTypedDataSigner(api, { walletId: eoa.id, address: eoa.address }).signTypedData(td),
    });
    const signX402 = makeSignX402({
      signer,
      chainId: CHAIN_ID,
      network: arcBatchingConfig.network,
      verifyingContract: GATEWAY,
    });
    const settle = makeSettle({ facilitatorUrl: FACILITATOR });
    const paywall = buildPaywall({
      price: PRICE,
      payTo: PAY_TO,
      asset: USDC,
      network: arcBatchingConfig.network,
      serve: () => ({ probe: "tier0-p2" }),
      settle,
      resourceUrl: "probe://tier0-p2",
      resource: "/api/probe",
    });
    const t0 = Date.now();
    const { header } = await signX402({
      payTo: PAY_TO,
      amount: PRICE,
      asset: USDC,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 600,
    });
    console.log(`  signed x402 authorization through Circle in ${Date.now() - t0}ms`);
    const res = await paywall.request("/api/probe", { headers: { "X-PAYMENT": header } });
    console.log(`  paywall response: ${res.status}`);
    results.D =
      res.status === 200
        ? "SETTLED — facilitator accepted the Circle-MPC-signed authorization"
        : `NOT SETTLED (status ${res.status}: ${await res.text()})`;
    console.log(`  → ${results.D}`);
  }

  // ── Probe E: SCA in-flight queue ─────────────────────────────────────────────────────────
  if (want("E")) {
    banner("Probe E — two CONCURRENT contractExecutions from the SCA");
    const mk = (n: number) =>
      submitAndConfirm(
        api,
        {
          walletId: sca.id,
          contractAddress: USDC,
          callData: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [GATEWAY, BigInt(n)],
          }),
          idempotencySeed: `p2:queue:${n}:${Date.now()}`,
        },
        confirmOpts,
      ).then(
        (r) => ({ n, ok: true as const, ...r }),
        (e) => ({ n, ok: false as const, err: (e as Error).message }),
      );
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([mk(1), mk(2)]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    for (const r of [r1, r2])
      console.log(`  op${r.n}: ${r.ok ? `OK ${r.txHash}` : `FAILED ${r.err}`}`);
    results.E = `both concurrent ops: ${r1.ok && r2.ok ? "ACCEPTED" : "SEE ABOVE"} in ${secs}s total`;
    console.log(`  → ${results.E}`);
  }

  banner("P2 RESULTS");
  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
}

main().catch((e) => {
  console.error("\nP2 experiment failed:", e);
  process.exit(1);
});
