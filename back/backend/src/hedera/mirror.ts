/**
 * The Hedera mirror node REST client — the server's ONLY window onto Hedera state.
 *
 * The mirror node is a read-only, eventually-consistent index of consensus. That shapes every
 * decision here:
 *
 *  - **Reads only.** The server never submits a Hedera transaction; the client signs and submits,
 *    the server verifies afterwards. So this is a REST client and not an SDK wrapper (design D24,
 *    the same reasoning `keyDecode.ts` is hand-written for).
 *  - **Every call is deadline-bounded** with the shared `withDeadline`, and the deadline covers
 *    the BODY READ, not just the headers. These calls run inside request handlers; a stalled
 *    socket with no RST would otherwise pin a request until the OS gives up.
 *  - **404 is data, every other non-200 is an error.** "This account does not exist" and "this
 *    transaction is not indexed yet" are ordinary answers the caller acts on. A 500 or a 429 is
 *    not: returning `null` for those would let a mirror node outage read as "the agent has no
 *    key", which is the one failure this module must never produce silently.
 *  - **`waitTransaction` takes its clock and its sleep.** Consensus-to-mirror lag is real, so the
 *    caller polls; injecting `now` and `sleep` is what makes that polling testable without a
 *    fake timer, and what keeps the loop honest about its own deadline.
 */

import { withDeadline } from "../util/deadline";

/** Default read deadline. Mirror node p99 is well under a second; this is a hang bound. */
export const MIRROR_TIMEOUT_MS = 10_000;

/** Every failure this client raises, so a call site can branch without sniffing message strings. */
export class MirrorError extends Error {
  constructor(
    /** The request path, query included. */
    readonly path: string,
    /** The HTTP status, or `null` when the call never produced one (timeout). */
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "MirrorError";
  }
}

export interface MirrorAccount {
  account: string;
  keyHex: string | null;
  keyType: string | null;
  evmAddress: string | null;
}

export interface MirrorTransfer {
  tokenId: string;
  account: string;
  amount: bigint;
}

export interface MirrorTransaction {
  transactionId: string;
  name: string;
  result: string;
  consensusTimestamp: string;
  tokenTransfers: MirrorTransfer[];
}

/** The mirror node's JSON, named as it comes off the wire. Every field is optional on purpose:
 *  this is a surface we do not control, and a missing field must not throw at the property read. */
interface RawAccount {
  account?: string | null;
  evm_address?: string | null;
  key?: { _type?: string | null; key?: string | null } | null;
}
interface RawTokens {
  tokens?: { token_id?: string | null; balance?: number | string | null }[] | null;
}
interface RawTransaction {
  transaction_id?: string | null;
  name?: string | null;
  result?: string | null;
  consensus_timestamp?: string | null;
  token_transfers?:
    | { token_id?: string | null; account?: string | null; amount?: number | string | null }[]
    | null;
}
interface RawTransactions {
  transactions?: RawTransaction[] | null;
}

/**
 * Rewrite a transaction id into the form the mirror node's path segment takes:
 * `0.0.7162784@1788998489.006924053` -> `0.0.7162784-1788998489-006924053`.
 * An id already in the dashed form passes through, so callers may hand over either.
 */
export function mirrorTxId(id: string): string {
  const at = id.indexOf("@");
  if (at === -1) return id;
  // Only the FIRST dot of the valid-start timestamp becomes a dash; the account id keeps its own.
  return `${id.slice(0, at)}-${id.slice(at + 1).replace(".", "-")}`;
}

export class HederaMirror {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs: number = MIRROR_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** GET a path. `null` on 404, a `MirrorError` on anything else that is not a 200. */
  private get<T>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    return withDeadline(
      this.timeoutMs,
      async (signal) => {
        const res = await this.fetchImpl(url, { signal, headers: { accept: "application/json" } });
        if (res.status === 404 || !res.ok) {
          // Drain nothing, free the socket: an undrained error body holds the connection open.
          await res.body?.cancel().catch(() => {});
          if (res.status === 404) return null;
          throw new MirrorError(path, res.status, `mirror ${path} -> ${res.status}`);
        }
        try {
          return (await res.json()) as T;
        } catch {
          // A 200 whose body is not JSON is a proxy or a captive portal answering for the mirror
          // node. It must surface as a MirrorError like any other bad answer, not as a bare
          // SyntaxError a call site has no way to branch on.
          throw new MirrorError(path, res.status, `mirror ${path} -> unreadable JSON body`);
        }
      },
      () => new MirrorError(path, null, `mirror ${path} timed out after ${this.timeoutMs}ms`),
    );
  }

  /** The account, or `null` when the mirror node has never seen it. */
  async account(id: string): Promise<MirrorAccount | null> {
    const raw = await this.get<RawAccount>(`/api/v1/accounts/${encodeURIComponent(id)}`);
    if (!raw) return null;
    return {
      account: raw.account ?? id,
      keyHex: raw.key?.key ?? null,
      keyType: raw.key?._type ?? null,
      evmAddress: raw.evm_address ?? null,
    };
  }

  /** The account's balance of one token. `0n` when it holds none, and when it is not associated. */
  async tokenBalance(id: string, tokenId: string): Promise<bigint> {
    const path = `/api/v1/accounts/${encodeURIComponent(id)}/tokens?token.id=${encodeURIComponent(tokenId)}`;
    const raw = await this.get<RawTokens>(path);
    const balance = raw?.tokens?.[0]?.balance;
    return balance === undefined || balance === null ? 0n : BigInt(balance);
  }

  /** Every record filed under one transaction id, or `null` while the id is not indexed yet. */
  async transaction(txId: string): Promise<MirrorTransaction[] | null> {
    const path = `/api/v1/transactions/${encodeURIComponent(mirrorTxId(txId))}`;
    const raw = await this.get<RawTransactions>(path);
    const records = raw?.transactions;
    // An empty list is the same answer as a 404 to every caller: nothing has landed yet.
    if (!records || records.length === 0) return null;
    return records.map((r) => ({
      transactionId: r.transaction_id ?? mirrorTxId(txId),
      name: r.name ?? "",
      result: r.result ?? "",
      consensusTimestamp: r.consensus_timestamp ?? "",
      tokenTransfers: (r.token_transfers ?? []).map((t) => ({
        tokenId: t.token_id ?? "",
        account: t.account ?? "",
        amount: BigInt(t.amount ?? 0),
      })),
    }));
  }

  /**
   * Poll `transaction` until it answers, or until `timeoutMs` of the caller's clock has elapsed.
   * Always makes at least one attempt, so a zero timeout still asks once.
   */
  async waitTransaction(
    txId: string,
    opts: {
      timeoutMs: number;
      intervalMs: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ): Promise<MirrorTransaction[] | null> {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const start = now();
    for (;;) {
      const records = await this.transaction(txId);
      if (records) return records;
      if (now() - start >= opts.timeoutMs) return null;
      await sleep(opts.intervalMs);
    }
  }
}
