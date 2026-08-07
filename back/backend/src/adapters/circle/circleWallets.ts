// Namespace import is deliberate — see the CJS/ESM interop note in buildCircleWalletsApi.
import * as dcwModule from "@circle-fin/developer-controlled-wallets";
import { encodeFunctionData } from "viem";
import { opsLog } from "../../observability/opsLog";
import type { Address, Hex } from "../../types";
import type { AgentkitSigner } from "../worldid/agentkitSigner";
import type { SubmitAndConfirmOptions } from "./circleExec";
import { submitAndConfirm } from "./circleExec";

/**
 * Tier-0 Circle DevC adapter (P1b) — docs/design/2026-08-03-tier0-circle-wallet-migration.md.
 *
 * Design constraints honored:
 * - NARROW INJECTABLE SURFACE (`CircleWalletsApi`): tests fake it; production wraps the real SDK.
 *   The SDK's ESM named exports are broken in plain Node (verified 2026-08-04) — inside src/tests
 *   the tsx/vitest CJS interop handles the import; standalone .mts scripts must use require().
 * - EVERY MUTATING CALL LOGS (`withCircleOpsLog`) — S5 parity with `turnkey_sig`: when something
 *   eats the bill or the rate limit, journald must be able to say what. Observe, never gate.
 * - Signers plug into EXISTING seams, replacing nothing: `circleTypedDataSigner` feeds
 *   `asBatchEvmSigner`/`signX402` (x402 payment auth + Gateway burn intents);
 *   `circleAgentkitSigner` satisfies the World AgentKit `eip191` signer shape.
 * - ONE platform wallet set (`novi-tier0`, CIRCLE_WALLET_SET_ID) — decided at credential
 *   validation; per-agent wallets are tagged with the entity key via metadata.refId.
 */

/** The slice of the DevC SDK we consume. Kept minimal so tests can fake it honestly. */
export interface CircleWalletsApi {
  createWallets(input: {
    accountType: "SCA" | "EOA";
    blockchains: string[];
    count: number;
    walletSetId: string;
    metadata?: { name?: string; refId?: string }[];
  }): Promise<{
    data?: {
      wallets?: {
        id: string;
        address: string;
        blockchain: string;
        accountType: string;
        scaCore?: string;
      }[];
    };
  }>;
  signTypedData(input: {
    walletId: string;
    data: string;
  }): Promise<{ data?: { signature?: string } }>;
  signMessage(input: {
    walletId: string;
    message: string;
  }): Promise<{ data?: { signature?: string } }>;
  /** Async on-chain execution: returns a Circle tx-id immediately; poll getTransaction for the
   *  hash. idempotencyKey MUST be a UUID; reuse replays the original response (crash-retry safe). */
  createContractExecutionTransaction(input: {
    walletId: string;
    contractAddress: string;
    callData: `0x${string}`;
    fee: { type: "level"; config: { feeLevel: "LOW" | "MEDIUM" | "HIGH" } };
    idempotencyKey: string;
    refId?: string;
  }): Promise<{ data?: { id?: string; state?: string } }>;
  getTransaction(input: { id: string }): Promise<{
    data?: {
      transaction?: {
        id?: string;
        state?: string;
        txHash?: string;
        networkFee?: string;
        errorReason?: string;
      };
    };
  }>;
}

/** Real client, opsLog-wrapped. `cfg` mirrors Config.circle + the wallet-set id. */
export function buildCircleWalletsApi(cfg: {
  apiKey: string;
  entitySecret: string;
}): CircleWalletsApi {
  // INTEROP SHIM (verified 2026-08-04): the SDK ships CJS whose named exports node's ESM lexer
  // cannot detect — under a real ESM entrypoint the namespace only has `default`, while vitest
  // and tsx's CJS transform surface the names directly. Cover both worlds.
  const ns = dcwModule as unknown as {
    initiateDeveloperControlledWalletsClient?: (c: unknown) => unknown;
    default?: { initiateDeveloperControlledWalletsClient?: (c: unknown) => unknown };
  };
  const initiate =
    ns.initiateDeveloperControlledWalletsClient ??
    ns.default?.initiateDeveloperControlledWalletsClient;
  if (!initiate)
    throw new Error("developer-controlled-wallets SDK: client initializer not found (interop)");
  const client = initiate({
    apiKey: cfg.apiKey,
    entitySecret: cfg.entitySecret,
  }) as CircleWalletsApi;
  return withCircleOpsLog(client);
}

const MUTATING: (keyof CircleWalletsApi)[] = [
  "createWallets",
  "signTypedData",
  "signMessage",
  "createContractExecutionTransaction",
];

/** S5 parity: one journald line per mutating Circle call. Logging failure never blocks the call.
 *  PROXY, not `{...api}` (P3 leg-1 catch): the real SDK client is a CLASS INSTANCE whose methods
 *  live on the prototype — an object spread silently DROPS every method it doesn't explicitly
 *  rewrap (getTransaction died first, in the very first production-wrapped call). Plain-object
 *  test fakes could never catch that; the prototype-based regression test now does. */
export function withCircleOpsLog(api: CircleWalletsApi): CircleWalletsApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;
      if (!(MUTATING as string[]).includes(prop as string)) return original.bind(target);
      return async (input: Record<string, unknown>) => {
        try {
          opsLog("circle_call", {
            method: prop,
            walletId: input?.walletId,
            accountType: input?.accountType,
          });
        } catch {
          // observe, don't gate
        }
        return (original as (i: unknown) => Promise<unknown>).call(target, input);
      };
    },
  });
}

export interface CircleWalletRef {
  walletId: string;
  address: string;
  scaCore?: string;
}

const erc20ApproveAbi = [
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
] as const;

/**
 * Deploy ("activate") a freshly-provisioned operator SCA with one Gas-Station-sponsored no-op:
 * approve(gatewayWallet, 0). P2 probe A proved Circle REFUSES to produce any signature from an
 * undeployed SCA ("initiate a transaction to deploy the wallet"), and the onboarding saga's very
 * next SCA touch is the bind SIGNATURE — so provisioning must leave the SCA deployed, not
 * counterfactual. Deterministic idempotency seed keyed to the WALLET id, not the entity key
 * (P3 leg-1 catch): re-provisioning mints a FRESH wallet under the SAME entity key, and an
 * entity-keyed seed made Circle replay the previous pair's activation — "confirming" a deploy of
 * the ORPHANED wallet while the new SCA stayed counterfactual. Same-wallet crash-retries still
 * replay exactly. Probe B measured the cost: ~0.009 USDC sponsored fee, ~3s to confirm.
 */
export async function activateCircleSca(
  api: Pick<CircleWalletsApi, "createContractExecutionTransaction" | "getTransaction">,
  p: {
    operatorWalletId: string;
    entityKey: string;
    usdc: string;
    gatewayWallet: string;
    confirm?: SubmitAndConfirmOptions;
    /** S5: Gas Station sponsorship observed from the confirmed-tx fee (recorded, never checked). */
    outflows?: { record(path: "gas_sponsorship", amountAtomic: bigint, ref: string | null): void };
  },
): Promise<{ txHash: Hex }> {
  const { txHash } = await submitAndConfirm(
    api,
    {
      walletId: p.operatorWalletId,
      contractAddress: p.usdc as Address,
      callData: encodeFunctionData({
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [p.gatewayWallet as Address, 0n],
      }),
      idempotencySeed: `activate:${p.operatorWalletId}`,
      refId: `${p.entityKey}:activate`,
    },
    {
      ...p.confirm,
      onNetworkFee: (fee, txId) => p.outflows?.record("gas_sponsorship", fee, txId),
    },
  );
  return { txHash };
}

/** One SCA (operator) + one EOA (pocket) per agent, both tagged with the entity key. */
export async function provisionCircleWallets(
  api: CircleWalletsApi,
  p: { walletSetId: string; blockchain: string; entityKey: string },
): Promise<{ operator: CircleWalletRef; pocket: CircleWalletRef }> {
  const create = async (accountType: "SCA" | "EOA", role: string): Promise<CircleWalletRef> => {
    const res = await api.createWallets({
      accountType,
      blockchains: [p.blockchain],
      count: 1,
      walletSetId: p.walletSetId,
      metadata: [{ name: `${role}:${p.entityKey}`, refId: p.entityKey }],
    });
    const w = res.data?.wallets?.[0];
    if (!w?.id || !w?.address)
      throw new Error(
        `Circle createWallets(${accountType}) returned no wallet for ${p.entityKey} — refusing a half-provisioned agent`,
      );
    return { walletId: w.id, address: w.address, scaCore: w.scaCore };
  };
  // Sequential on purpose: if the SCA fails, no orphan pocket exists to clean up.
  const operator = await create("SCA", "operator");
  const pocket = await create("EOA", "pocket");
  return { operator, pocket };
}

/** Feeds the EXISTING x402 seam (`asBatchEvmSigner`): {address, signTypedData}. The SDK wants
 *  the EIP-712 payload as a JSON string in `data` — and x402 typed data carries BigInt values
 *  (amounts, deadlines), which plain JSON.stringify REJECTS ("Do not know how to serialize a
 *  BigInt"; caught by the P1c pay-path test). uint256 fields serialize as decimal strings, the
 *  representation EIP-712 JSON expects. */
export function circleTypedDataSigner(
  api: CircleWalletsApi,
  wallet: { walletId: string; address: string },
): { address: string; signTypedData(typedData: unknown): Promise<Hex> } {
  return {
    address: wallet.address,
    async signTypedData(typedData: unknown): Promise<Hex> {
      const res = await api.signTypedData({
        walletId: wallet.walletId,
        data: JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const sig = res.data?.signature;
      if (!sig)
        throw new Error(`Circle signTypedData returned no signature (wallet ${wallet.walletId})`);
      return sig as Hex;
    },
  };
}

/** OperatorSigner for the onboarding saga's Step-5 bind: the operator SCA signs the ERC-8004
 *  `AgentWalletSet` typed data through Circle. P2 VERDICT (2026-08-06, probe F): the LIVE Arc
 *  registry accepts this ERC-1271 signature — proven on an anvil fork of real registry code+state
 *  with a real MPC signature (agentId 845775 rebound to the SCA; getAgentWallet matched).
 *  PRECONDITION (probe A): the SCA must be DEPLOYED first — Circle refuses to sign from an
 *  undeployed wallet — hence `activateCircleSca` below runs during provisioning. */
export function circleOperatorSigner(
  api: CircleWalletsApi,
  wallet: { walletId: string; address: string },
): { address: `0x${string}`; signWalletSet(typedData: unknown): Promise<Hex> } {
  const typed = circleTypedDataSigner(api, wallet);
  return {
    address: wallet.address as `0x${string}`,
    signWalletSet: (typedData: unknown) => typed.signTypedData(typedData),
  };
}

/** Satisfies the World AgentKit signer shape (EIP-191 personal_sign via Circle). */
export function circleAgentkitSigner(
  api: CircleWalletsApi,
  wallet: { walletId: string; address: string },
  chainId: number,
): AgentkitSigner {
  return {
    address: wallet.address,
    chainId: `eip155:${chainId}`,
    type: "eip191",
    signMessage: async (message: string) => {
      const res = await api.signMessage({ walletId: wallet.walletId, message });
      const sig = res.data?.signature;
      if (!sig)
        throw new Error(`Circle signMessage returned no signature (wallet ${wallet.walletId})`);
      return sig;
    },
  };
}
