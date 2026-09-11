// test/helpers/hederaApp.ts — the one scaffold every Hedera test builds on.
import Database from "better-sqlite3";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import type { FormationSummary } from "../../src/formation/status";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

export const WEB = "https://www.novicorpus.test";
export const METADATA_BASE = "https://api.novicorpus.test";
export const PUBLIC_ID = "9f8003f5-4c70-435a-9980-9a54625691b7";
export const TREASURY = "0x92ae7c6b6eB9470d7E01F8fEb352714bD80A7AAf"; // FormationE2E_1's, so a scaffold UAID equals the task 9 golden vector
export const PROXY = "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE";
export const TENANT = "0x000000000000000000000000000000000000000A";

/** The demo entity's shape, public on chain, verified controller absent unless overridden. */
export const entity = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: `${TENANT}:FormationE2E_1`,
    name: "FormationE2E_1",
    status: "funded",
    manager: "0x0000000000000000000000000000000000000001",
    guardian: "0x0000000000000000000000000000000000000002",
    operator: null,
    amendmentDelay: "0",
    ein: "12-3456789",
    formationDate: 0,
    oaHash: null,
    metadataURI: `${METADATA_BASE}/metadata/${PUBLIC_ID}`,
    docPath: null,
    treasuryConfig: {
      usdc: "0x0000000000000000000000000000000000000002",
      payoutAddress: TREASURY,
      cap: 1_000_000_000n,
      period: 86_400n,
      allowlistEnabled: false,
    },
    agentId: "886257",
    proxy: PROXY,
    treasury: TREASURY,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: TENANT,
    walletProvider: "circle",
    publicId: PUBLIC_ID,
    ...over,
  }) as EntityRecord;

/** A real in-memory database with the demo entity seeded, plus the stores MCP tests need. */
export function hederaDb(over: Partial<EntityRecord> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const rec = entity(over);
  repo.upsert(rec);
  return { db, repo, rec, apiKeys: new SqliteApiKeyStore(db) };
}

/** The Arc reads a legal body needs, scripted. Shaped to stand in for BOTH `legalBody.chainReads`
 *  (two methods) and the `arc` adapter's live treasury reads, which is why `treasuryAllowlistEnabled`
 *  lives here too: the allowlist flag is read from the chain on every check, never from the row. */
export const arcReads = (
  o: { status?: number; paused?: boolean; allowlistEnabled?: boolean; throws?: boolean } = {},
) => ({
  legalStatus: async () => {
    if (o.throws) throw new Error("rpc down");
    return o.status ?? 0;
  },
  treasuryPaused: async () => {
    if (o.throws) throw new Error("rpc down");
    return o.paused ?? false;
  },
  treasuryAllowlistEnabled: async () => {
    if (o.throws) throw new Error("rpc down");
    return o.allowlistEnabled ?? false;
  },
});

/** The app with the deps a Hedera test controls. Anything not listed is `undefined`, as in
 *  `test/api/legalBodies.test.ts` (the `as never` cast is that file's idiom). */
export function hederaApp(o: {
  repo: SqliteEntityRepository;
  apiKeys?: SqliteApiKeyStore;
  hedera?: unknown;
  /** The Arc adapter, for the LIVE treasury reads (`treasuryAllowlistEnabled`). Left undefined by
   *  default so a test that does not script it falls back to the entity row, as before. */
  arc?: unknown;
  legalBody?: unknown;
  worldId?: unknown;
  ens?: unknown;
  now?: () => number;
  formationSummary?: (companyId: string) => FormationSummary | null;
}) {
  return buildApiApp({
    webOrigin: WEB,
    jwtSecret: "s",
    chainId: 5042002,
    repo: o.repo,
    apiKeys: o.apiKeys,
    now: o.now ?? (() => 1_789_100_000_000), // 2026-09-10, the design date
    hedera: o.hedera,
    arc: o.arc,
    legalBody: o.legalBody ?? {
      resolver: { resolve: async () => ({ kind: "none" }) },
      chainReads: arcReads(),
      readBudget: new TokenBucket(30, 1),
      links: { transparency: `${WEB}/transparency`, metadataBase: METADATA_BASE },
      formationSummary: o.formationSummary,
      network: "testnet" as const,
    },
    worldId: o.worldId,
    ens: o.ens,
  } as never);
}

/** A scripted mirror node: each method answers from the script, and records its calls. */
export function fakeMirror(script: {
  account?: {
    account: string;
    keyHex: string | null;
    keyType: string | null;
    evmAddress: string | null;
  } | null;
  tokenBalance?: bigint;
  transaction?: unknown[] | null;
}) {
  const calls: string[] = [];
  return {
    calls,
    account: async (id: string) => {
      calls.push(`account:${id}`);
      return script.account ?? null;
    },
    tokenBalance: async (id: string) => {
      calls.push(`balance:${id}`);
      return script.tokenBalance ?? 0n;
    },
    transaction: async (id: string) => {
      calls.push(`tx:${id}`);
      return script.transaction ?? null;
    },
    waitTransaction: async (id: string) => {
      calls.push(`wait:${id}`);
      return script.transaction ?? null;
    },
  };
}
