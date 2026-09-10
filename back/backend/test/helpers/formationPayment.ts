import { keccak256, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import type { FormationExecutorDeps } from "../../src/payments/formationSettle";
import type { FormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import type { Address, Hex } from "../../src/types";

/**
 * THE FORMATION-PAYMENT TEST FIXTURE, in one place (finding C6).
 *
 * Five test files had their own `paymentCfg` and their own fake chain, and they had already
 * drifted: three of them pinned a USDC domain of `name: "USD Coin"`, which is what every
 * reference implementation says and is NOT what Arc's predeploy reports. The live probe
 * (2026-09-09, chain 5042002) read `name: "USDC", version: "2"` — see
 * docs/runbooks/formation-settle-probe-2026-09.md. A fixture that disagrees with the chain is a
 * suite that passes while the product cannot settle, which is the precise failure `readUsdcDomain`
 * exists to prevent and the precise failure five copies of a domain literal will reproduce.
 */

export const USDC = "0x3600000000000000000000000000000000000000" as Address;
export const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
export const CHAIN_ID = 5042002;

/**
 * ⚠ THE REAL DOMAIN, as the token reports it on Arc — `USDC`, not `USD Coin`.
 *
 * Measured by the live merge gate rather than copied from Circle's documentation. It is the whole
 * argument for reading the domain from the chain at boot: getting these two strings wrong is
 * invisible until a guardian has signed, because our own verification would check against the
 * same wrong domain we asked them to sign.
 */
export const USDC_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: CHAIN_ID,
  verifyingContract: USDC,
} as const;

export function paymentCfg(
  payments: FormationPaymentRepository,
  over: Partial<FormationPaymentConfig> = {},
): FormationPaymentConfig {
  return {
    required: true,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    settleGraceMs: 15 * 60 * 1000,
    // Read and pinned at boot in production; a literal here, because these files are about the
    // row and the transaction rather than about the chain read (usdcToken.test.ts covers that).
    domain: USDC_DOMAIN,
    payments,
    ...over,
  };
}

/** One of the token's logs, in the shape viem hands back. */
export interface FakeLog {
  name: "AuthorizationUsed" | "AuthorizationCanceled" | "Transfer";
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
}

/** The PAIR of logs a real settlement leaves: the nonce retired, and the money moved. Both are
 *  needed for a `settled` verdict — a consumed nonce alone would ready a company nobody paid. */
export function settlementLogs(opts: {
  authorizer: Address;
  payTo: Address;
  nonce: Hex;
  txHash: Hex;
  value?: bigint;
  block?: bigint;
}): FakeLog[] {
  const block = opts.block ?? 100n;
  return [
    {
      name: "AuthorizationUsed",
      args: { authorizer: opts.authorizer, nonce: opts.nonce },
      blockNumber: block,
      transactionHash: opts.txHash,
    },
    {
      name: "Transfer",
      args: { from: opts.authorizer, to: opts.payTo, value: opts.value ?? 399_000_000n },
      blockNumber: block,
      transactionHash: opts.txHash,
    },
  ];
}

export function cancelLog(opts: {
  authorizer: Address;
  nonce: Hex;
  txHash: Hex;
  block?: bigint;
}): FakeLog {
  return {
    name: "AuthorizationCanceled",
    args: { authorizer: opts.authorizer, nonce: opts.nonce },
    blockNumber: opts.block ?? 100n,
    transactionHash: opts.txHash,
  };
}

export interface FakeChainOptions {
  receipt?: "success" | "reverted" | "timeout";
  /** Transactions the node ACCEPTS but never mines — by nonce. A pending transaction holds its
   *  nonce, so the next attempt must REPLACE it rather than queue behind it (R1). */
  stuckNonces?: number[];
  /** Nonces the token reports as spent (`authorizationState`), lower-cased. */
  spent?: Iterable<string>;
  /** The submitter's account nonce. A transaction below it is rejected forever. */
  accountNonce?: number;
  /** The token's own logs — where an outcome actually comes from (gate A3). */
  logs?: FakeLog[];
  head?: bigint;
  /** The latest block's timestamp, unix seconds — the only clock that may expire anything. */
  blockTimestamp?: number;
}

/**
 * A FAKE CHAIN with the properties the payment path actually depends on:
 *
 *  - the submitter HAS A NONCE, and a transaction whose nonce is below the account's is rejected
 *    forever ("nonce too low") — the failure the persisted-raw-transaction scheme could not
 *    survive and the persisted AUTHORIZATION does;
 *  - `authorizationState` is a set of spent nonces, which is exactly what the token's storage is;
 *  - the LOGS are queryable by both indexed topics, which is how an outcome is resolved;
 *  - the CLOCK is the block's, not the process's.
 *
 * `verifyTypedData` delegates to viem's offline check, which for the EOA guardians these fixtures
 * use is exactly what a real client would conclude — a real one tries ECDSA first and only then
 * ERC-1271.
 */
export function fakeChain(opts: FakeChainOptions = {}) {
  const sent: Hex[] = [];
  const state = {
    receipt: opts.receipt ?? ("success" as "success" | "reverted" | "timeout"),
    spent: new Set([...(opts.spent ?? [])].map((n) => n.toLowerCase())),
    accountNonce: opts.accountNonce ?? 7,
    /** The CONFIRMED count — what `blockTag: "latest"` answers. It advances only when a
     *  transaction actually mines, which is the distinction the replacement rule turns on. */
    confirmedNonce: opts.accountNonce ?? 7,
    stuck: new Set(opts.stuckNonces ?? []),
    /** Hashes the node ACCEPTED. A receipt exists for nothing else. */
    accepted: new Set<string>(),
    logs: opts.logs ?? [],
    head: opts.head ?? 5_000n,
    blockTimestamp: BigInt(opts.blockTimestamp ?? Math.floor(Date.now() / 1000)),
  };
  const publicClient = {
    getTransactionCount: async ({ blockTag }: { blockTag?: string } = {}) =>
      blockTag === "latest" ? state.confirmedNonce : state.accountNonce,
    getBlockNumber: async () => state.head,
    getBlock: async () => ({ number: state.head, timestamp: state.blockTimestamp }),
    getLogs: async (q: {
      event: { name: string };
      args?: Record<string, unknown>;
      fromBlock: bigint;
      toBlock: bigint;
    }) =>
      state.logs.filter(
        (l) =>
          l.name === q.event.name &&
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock &&
          Object.entries(q.args ?? {}).every(
            ([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase(),
          ),
      ),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const { nonce } = decodeFakeTx(serializedTransaction);
      if (nonce < state.confirmedNonce) throw new Error("nonce too low");
      // A transaction the node keeps in the mempool advances the PENDING count and nothing else.
      // One that mines advances both.
      state.accountNonce = Math.max(state.accountNonce, nonce + 1);
      if (!state.stuck.has(nonce)) state.confirmedNonce = Math.max(state.confirmedNonce, nonce + 1);
      sent.push(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      state.accepted.add(hash);
      return hash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (state.receipt === "timeout" || !state.accepted.has(hash))
        throw new Error("timed out waiting for receipt");
      return { status: state.receipt, gasUsed: 118_000n, transactionHash: hash };
    },
    readContract: async ({ args }: { args: unknown[] }) =>
      state.spent.has(String(args[1]).toLowerCase()),
    verifyTypedData: async (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    getCode: async () => undefined,
    // biome-ignore lint/suspicious/noExplicitAny: a stub of viem's PublicClient
  } as any;
  const walletClient = {
    account: privateKeyToAccount(`0x${"9".repeat(64)}`),
    signTransaction: async (tx: Record<string, unknown>) =>
      // A deterministic stand-in for a serialized transaction: the tests care that the same
      // AUTHORIZATION goes to the chain and that the nonce is current, not that it is RLP.
      // Bigints are stringified explicitly — JSON has none, and the real serializer does not care.
      `0x02${Buffer.from(
        JSON.stringify({ ...tx, account: undefined }, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      ).toString("hex")}` as Hex,
    // biome-ignore lint/suspicious/noExplicitAny: a two-field stub of viem's WalletClient
  } as any;
  const executor: FormationExecutorDeps = {
    publicClient,
    walletClient,
    usdc: USDC,
    chainId: CHAIN_ID,
  };
  return { executor, sent, state };
}

/** The inverse of the stub signer above: read back what a composed transaction committed to. */
export function decodeFakeTx(raw: Hex): { nonce: number; data: string } {
  return JSON.parse(Buffer.from(raw.slice(4), "hex").toString());
}
